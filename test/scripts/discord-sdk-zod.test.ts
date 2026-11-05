import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiscordActivitySdk } from "../../scripts/build-discord-activity-sdk.mts";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

type Schema = {
  parse: (input: unknown) => unknown;
  safeParse: (input: unknown) => { success: boolean; error?: { issues: unknown[] } };
};
type Sdk = {
  Common: {
    Scopes: Schema;
    GuildMember: { shape: { roles: { max: (limit: number) => Schema } } };
  };
};
type Schemas = { AuthenticateResponseSchema: Schema; ShareInteractionRequestSchema: Schema };
const require = createRequire(new URL("../../extensions/discord/package.json", import.meta.url));
const sdkDir = path.dirname(require.resolve("@discord/embedded-app-sdk/package.json"));
const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

// The SDK ships its own Zod 3 implementation; a root Zod override cannot repair it.
// Exercise both shipped entrypoints, not an unrelated root parser.
type VendorZod = typeof import("zod/v3");

describe("Discord SDK security-patched Zod", () => {
  it.each(["mjs", "cjs"])(
    "rejects oversized collections before element/refinement work (%s)",
    async (extension) => {
      const z = (await import(
        pathToFileURL(path.join(sdkDir, "output/lib/zod/lib/index." + extension)).href
      )) as VendorZod;
      for (const asyncMode of [false, true]) {
        for (const kind of ["array-max", "array-length", "set-max", "set-size"]) {
          let elementCalls = 0;
          let refinementCalls = 0;
          const element = z.string().superRefine(() => {
            elementCalls += 1;
          });
          const collection = kind.startsWith("array") ? z.array(element) : z.set(element);
          const capped: import("zod/v3").ZodTypeAny = kind.endsWith("max")
            ? collection.max(2, "bounded")
            : kind === "array-length"
              ? z.array(element).length(2, "bounded")
              : z.set(element).size(2, "bounded");
          const schema = capped.superRefine(() => {
            refinementCalls += 1;
          });
          const input = kind.startsWith("array") ? ["a", "b", "c"] : new Set(["a", "b", "c"]);
          const result = asyncMode ? await schema.safeParseAsync(input) : schema.safeParse(input);
          expect(result.success).toBe(false);
          if (result.success) {
            throw new Error("oversized collection unexpectedly accepted");
          }
          expect(result.error.issues).toHaveLength(1);
          expect(result.error.issues[0]).toMatchObject({ code: "too_big", message: "bounded" });
          expect(elementCalls).toBe(0);
          expect(refinementCalls).toBe(0);
        }
        const nested = z.object({ values: z.array(z.string()).max(2, "limit") });
        const result = asyncMode
          ? await nested.safeParseAsync({ values: [1, 2, 3] })
          : nested.safeParse({ values: [1, 2, 3] });
        expect(result.success).toBe(false);
        if (result.success) {
          throw new Error("oversized nested array unexpectedly accepted");
        }
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]).toMatchObject({
          code: "too_big",
          path: ["values"],
          message: "limit",
        });
      }
      expect(z.array(z.string()).max(2).parse(["a", "b"])).toEqual(["a", "b"]);
      expect(
        z
          .array(z.string().transform((value) => value.toUpperCase()))
          .max(2)
          .parse(["a"]),
      ).toEqual(["A"]);
      expect(z.array(z.string()).length(2).safeParse(["a"]).success).toBe(false);
      expect(z.array(z.string()).min(2).safeParse(["a"]).success).toBe(false);
      expect(z.array(z.string()).max(2).safeParse({}).success).toBe(false);
      expect(z.set(z.string()).max(2).safeParse(["a"]).success).toBe(false);
      expect([
        ...z
          .set(z.string())
          .max(2)
          .parse(new Set(["a", "b"])),
      ]).toEqual(["a", "b"]);
    },
  );

  it.each(["mjs", "cjs"])(
    "retains bounded async parsing and reports aborted union branches (%s)",
    async (extension) => {
      const z = (await import(
        pathToFileURL(path.join(sdkDir, "output/lib/zod/lib/index." + extension)).href
      )) as VendorZod;
      let calls = 0;
      const asynchronousElement = z.string().refine(async () => {
        calls += 1;
        await Promise.resolve();
        return true;
      });
      expect((await z.array(asynchronousElement).max(1).safeParseAsync(["a", "b"])).success).toBe(
        false,
      );
      expect(calls).toBe(0);
      expect(
        await z
          .array(z.string().transform(async (value) => value.toUpperCase()))
          .max(2)
          .parseAsync(["a"]),
      ).toEqual(["A"]);
      expect(z.array(z.string()).length(2).parse(["a", "b"])).toEqual(["a", "b"]);
      expect([
        ...z
          .set(z.string())
          .size(2)
          .parse(new Set(["a", "b"])),
      ]).toEqual(["a", "b"]);
      expect(
        z
          .set(z.string())
          .min(2)
          .safeParse(new Set(["a"])).success,
      ).toBe(false);
      const result = z.union([z.array(z.string()).max(2), z.number()]).safeParse(["a", "b", "c"]);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Early abort intentionally changes a dirty branch's direct issue to a union wrapper.
        expect(result.error.issues[0]?.code).toBe("invalid_union");
      }
    },
  );

  it.each(["mjs", "cjs"])(
    "preserves authentication and rejects oversized buttons before parsing (%s)",
    async (extension) => {
      const sdk: Sdk = await import(
        pathToFileURL(path.join(sdkDir, "output", "index." + extension)).href
      );
      const schemas: Schemas = await import(
        pathToFileURL(path.join(sdkDir, "output/generated/schemas." + extension)).href
      );
      expect(sdk.Common.Scopes.parse("identify")).toBe("identify");
      expect(sdk.Common.Scopes.parse("future.scope")).toBe(-1);
      const response = {
        access_token: "fixture-token",
        user: { id: "1", username: "fixture", discriminator: "0", public_flags: 0 },
        scopes: ["identify", "future.scope", null],
        expires: "2030-01-01T00:00:00Z",
        application: { id: "2", name: "fixture", description: "fixture" },
      };
      expect(schemas.AuthenticateResponseSchema.parse(response)).toEqual({
        ...response,
        scopes: ["identify", -1, -1],
      });
      expect(
        schemas.AuthenticateResponseSchema.safeParse({ ...response, user: { id: 1 } }).success,
      ).toBe(false);
      const validButton = { type: 2, style: 1, label: "Open" };
      const validRequest = {
        command: "fixture",
        components: [{ type: 1, components: [validButton] }],
      };
      expect(schemas.ShareInteractionRequestSchema.parse(validRequest)).toEqual(validRequest);
      let elementReads = 0;
      const buttons = Array.from({ length: 6 }, () => ({
        get type() {
          elementReads += 1;
          return 2;
        },
        style: 1,
      }));
      const result = schemas.ShareInteractionRequestSchema.safeParse({
        command: "fixture",
        components: [{ type: 1, components: buttons }],
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues).toHaveLength(1);
      expect(elementReads).toBe(0);
    },
  );

  it("ships the repaired parser and scope handling through the production browser build", async () => {
    const dir = makeTempDir(tempDirs, "discord-sdk-zod-");
    const outputPath = path.join(dir, "embedded-app-sdk.mjs");
    await buildDiscordActivitySdk({ outputPath });
    const sdk: Sdk = await import(pathToFileURL(outputPath).href);
    expect(sdk.Common.Scopes.parse("identify")).toBe("identify");
    expect(sdk.Common.Scopes.parse("future.scope")).toBe(-1);
    let elementReads = 0;
    const roles = Array(6).fill("role");
    Object.defineProperty(roles, "0", {
      get() {
        elementReads += 1;
        return "role";
      },
    });
    expect(sdk.Common.GuildMember.shape.roles.max(5).safeParse(roles).success).toBe(false);
    expect(elementReads).toBe(0);
  });
});
