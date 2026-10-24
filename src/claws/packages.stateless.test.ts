import { describe, expect, it, vi } from "vitest";
import { installClawPackages } from "./packages.boundary.test-support.js";
import { packageInstallPlan } from "./packages.test-support.js";

describe("stateless Claw package install", () => {
  it("installs a skill with an in-memory receipt", async () => {
    const integrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    const installed = vi.fn(async (params: { beforePersistentApply?: () => void }) => {
      params.beforePersistentApply?.();
      return {
        ok: true as const,
        slug: "triage",
        version: "1.2.3",
        targetDir: "/tmp/incident-2/skills/triage",
      };
    });
    const plan = packageInstallPlan([
      { kind: "skill", source: "clawhub", ref: "@owner/triage", version: "1.2.3", integrity },
    ]);

    const refs = await installClawPackages(plan, {
      deps: {
        installSkill: installed,
        preflightSkill: vi.fn().mockResolvedValue({ ok: true, action: "install", integrity }),
        acquirePackageLease: vi.fn(async () => ({
          identity: {
            scope: "claw-package-lifecycle" as const,
            key: "test-package",
            owner: "test-owner",
          },
          assertCurrent: vi.fn(),
          release: vi.fn(),
        })),
      },
    });

    expect(installed).toHaveBeenCalledTimes(1);
    expect(refs).toMatchObject([{ kind: "skill", ref: "@owner/triage", status: "complete" }]);
  });
});
