import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import type { SecretProviderConfig } from "../config/types.secrets.js";
import {
  resolveSecretRefValue,
  resolveSecretRefValues,
  resolveSecretRefValuesSettledByProvider,
} from "./resolve.js";

const { readValue } = vi.hoisted(() => ({ readValue: vi.fn() }));
vi.mock("./store/secret-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store/secret-store.js")>();
  return { ...actual, readSecretStoreValue: readValue };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("reuses cached refs while batching newly requested provider refs", async () => {
  const root = tempDirs.make("openclaw-secret-resolve-cache-");
  const callLogPath = path.join(root, "calls.log");
  const providerScript = [
    'const fs = require("node:fs");',
    'let input = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    "  const ids = JSON.parse(input).ids;",
    `  fs.appendFileSync(${JSON.stringify(callLogPath)}, JSON.stringify(ids) + "\\n");`,
    "  const values = Object.fromEntries(ids.map((id) => [id, `value:${id}`]));",
    "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
    "});",
    "",
  ].join("\n");
  const ref = (id: string) => ({ source: "exec" as const, provider: "fixture", id });
  const options = {
    config: {
      secrets: {
        providers: {
          fixture: {
            source: "exec" as const,
            command: process.execPath,
            args: ["-e", providerScript],
            passEnv: ["PATH"],
          },
        },
      },
    },
    env: { PATH: process.env.PATH ?? "" },
    cache: {},
  };

  const first = await resolveSecretRefValues([ref("A"), ref("B")], options);
  const second = await resolveSecretRefValues([ref("A"), ref("B"), ref("C")], options);
  expect(first).toEqual(
    new Map([
      ["exec:fixture:A", "value:A"],
      ["exec:fixture:B", "value:B"],
    ]),
  );
  expect(second).toEqual(
    new Map([
      ["exec:fixture:A", "value:A"],
      ["exec:fixture:B", "value:B"],
      ["exec:fixture:C", "value:C"],
    ]),
  );
  const singleRef = ref("D");
  expect(
    await Promise.all([
      resolveSecretRefValue(singleRef, options),
      resolveSecretRefValue(singleRef, options),
    ]),
  ).toEqual(["value:D", "value:D"]);
  const calls = (await fs.readFile(callLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(calls).toEqual([["A", "B"], ["C"], ["D"]]);
});

it("does not cache a strict batch failure for healthy sibling refs", async () => {
  const missing = { source: "env" as const, provider: "default", id: "MISSING_KEY" };
  const healthy = { source: "env" as const, provider: "default", id: "HEALTHY_KEY" };
  const options = { config: {}, env: { HEALTHY_KEY: "healthy-secret" }, cache: {} };

  await expect(resolveSecretRefValues([missing, healthy], options)).rejects.toMatchObject({
    code: "SECRET_REF_NOT_FOUND",
    refId: "MISSING_KEY",
  });
  await expect(resolveSecretRefValue(healthy, options)).resolves.toBe("healthy-secret");
});

it("keeps overlapping healthy refs independent from strict batch failures", async () => {
  const missing = { source: "env" as const, provider: "default", id: "MISSING_KEY" };
  const healthy = { source: "env" as const, provider: "default", id: "HEALTHY_KEY" };
  const options = { config: {}, env: { HEALTHY_KEY: "healthy-secret" }, cache: {} };
  const strictBatch = resolveSecretRefValues([missing, healthy], options);
  const healthyLookup = resolveSecretRefValue(healthy, options);

  await expect(strictBatch).rejects.toMatchObject({
    code: "SECRET_REF_NOT_FOUND",
    refId: "MISSING_KEY",
  });
  await expect(healthyLookup).resolves.toBe("healthy-secret");
});

describe.each(["env", "file", "exec", "store"] as const)("%s mixed failures", (source) => {
  it.skipIf(source === "exec" && process.platform === "win32")(
    "retains every ref failure from one provider batch",
    async () => {
      const values = { REDACTED_KEY: REDACTED_SENTINEL, HEALTHY_KEY: "healthy-secret" };
      let provider: SecretProviderConfig;
      let command: string | undefined;
      if (source === "file" || source === "exec") {
        const root = tempDirs.make("openclaw-mixed-secret-failures-");
        const filePath = path.join(root, source === "file" ? "secrets.json" : "resolve.sh");
        if (source === "file") {
          await fs.writeFile(filePath, JSON.stringify(values), { mode: 0o600 });
          provider = { source, path: filePath, mode: "json" };
        } else {
          command = filePath;
          const response = JSON.stringify({
            protocolVersion: 1,
            values,
            errors: { ERROR_KEY: { code: "NOT_FOUND" } },
          });
          await fs.writeFile(
            filePath,
            `#!/bin/sh\nprintf 'run\\n' >> "$0.calls"\nprintf '%s' '${response}'\n`,
            { mode: 0o700 },
          );
          provider = { source, command };
        }
      } else {
        provider = { source };
      }
      if (source === "store") {
        readValue.mockImplementation(async ({ name }: { name: string }) =>
          name === "REDACTED_KEY" || name === "HEALTHY_KEY"
            ? { ok: true, value: values[name] }
            : {
                ok: false,
                error: { code: "SECRET_STORE_NOT_FOUND", message: "Missing fixture" },
              },
        );
      }
      const ref = (id: string) => ({
        source,
        provider: "fixture",
        id: source === "file" ? `/${id}` : id,
      });
      const missing = ref("MISSING_KEY");
      const redacted = ref("REDACTED_KEY");
      const healthy = ref("HEALTHY_KEY");
      const refs = [missing, redacted, healthy, ...(source === "exec" ? [ref("ERROR_KEY")] : [])];
      const options = { config: { secrets: { providers: { fixture: provider } } }, env: values };
      const result = await resolveSecretRefValuesSettledByProvider(refs, options);
      expect([...result.resolved]).toEqual([[`${source}:fixture:${healthy.id}`, "healthy-secret"]]);
      const failure = (refId: string, code: string) =>
        expect.objectContaining({ code, source, provider: "fixture", refId });
      expect(result.failures.map(({ error }) => error)).toEqual(
        expect.arrayContaining([
          failure(missing.id, "SECRET_REF_NOT_FOUND"),
          failure(redacted.id, "SECRET_REF_REDACTED_VALUE"),
          ...(source === "exec" ? [failure("ERROR_KEY", "SECRET_REF_NOT_FOUND")] : []),
        ]),
      );
      expect(result.failures).toHaveLength(source === "exec" ? 3 : 2);
      if (command) {
        expect(await fs.readFile(`${command}.calls`, "utf8")).toBe("run\n");
      }
      await expect(resolveSecretRefValues(refs, options)).rejects.toEqual(
        failure(missing.id, "SECRET_REF_NOT_FOUND"),
      );
    },
  );
});
