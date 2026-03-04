import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema relay routing", () => {
  it("accepts empty or missing relay routing config", () => {
    expect(() => SessionSchema.parse({})).not.toThrow();
    expect(() => SessionSchema.parse({ relayRouting: {} })).not.toThrow();
  });

  it("accepts valid relay routing config", () => {
    expect(() =>
      SessionSchema.parse({
        relayRouting: {
          defaultMode: "read-write",
          targets: {
            ops: { channel: "discord", to: "C123" },
          },
          rules: [
            {
              mode: "read-only",
              relayTo: "ops",
              match: {
                channel: "discord",
                chatIdPattern: "^C",
                senderPattern: "^U",
              },
            },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("rejects read-only rules without relayTo", () => {
    const result = SessionSchema.safeParse({
      relayRouting: {
        targets: {
          ops: { channel: "discord", to: "C123" },
        },
        rules: [{ mode: "read-only" }],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["relayRouting", "rules", 0, "relayTo"],
          message: expect.stringContaining('required when mode is "read-only"'),
        }),
      ]),
    );
  });

  it("rejects read-only rules with unknown relayTo targets", () => {
    const result = SessionSchema.safeParse({
      relayRouting: {
        targets: {
          ops: { channel: "discord", to: "C123" },
        },
        rules: [{ mode: "read-only", relayTo: "missing" }],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["relayRouting", "rules", 0, "relayTo"],
          message: expect.stringContaining("existing targets key"),
        }),
      ]),
    );
  });

  it("rejects empty relay target fields", () => {
    const result = SessionSchema.safeParse({
      relayRouting: {
        targets: {
          ops: { channel: "", to: "" },
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("relayRouting.targets.ops.channel");
    expect(paths).toContain("relayRouting.targets.ops.to");
  });
});
