import { describe, expect, it, vi } from "vitest";
import { installClawPackages } from "./packages.boundary.test-support.js";
import { packageInstallPlan } from "./packages.test-support.js";

describe("Claw package reviewed access", () => {
  it("rechecks reviewed access at a managed skill's persistent install boundary", async () => {
    const skillIntegrity = `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`;
    let accessCurrent = true;
    const persistentMutation = vi.fn();
    const installSkill = vi.fn(async (params: { beforePersistentApply?: () => void }) => {
      accessCurrent = false;
      params.beforePersistentApply?.();
      persistentMutation();
      return { ok: true as const, slug: "triage", version: "1.2.3", targetDir: "/tmp/triage" };
    });

    await expect(
      installClawPackages(
        packageInstallPlan([
          {
            kind: "skill",
            source: "clawhub",
            ref: "@owner/triage",
            version: "1.2.3",
            integrity: skillIntegrity,
          },
        ]),
        {
          assertForwardCurrent: () => {
            if (!accessCurrent) {
              throw new Error("reviewed access changed");
            }
          },
          deps: {
            installSkill,
            preflightSkill: vi
              .fn()
              .mockResolvedValue({ ok: true, action: "install", integrity: skillIntegrity }),
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
        },
      ),
    ).rejects.toThrow("reviewed access changed");

    expect(installSkill).toHaveBeenCalledOnce();
    expect(persistentMutation).not.toHaveBeenCalled();
  });
});
