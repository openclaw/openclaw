import { describe, expect, it, vi } from "vitest";
import { installClawPackages } from "./packages.js";
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
    const persistPackageRef = vi.fn().mockReturnValue({
      kind: "skill",
      ref: "@owner/triage",
      status: "pending",
      integrity: skillIntegrity,
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
            persistPackageRef,
            completePackageRef: vi.fn((ref, status) => ({ ...ref, status })),
            acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
          },
        },
      ),
    ).rejects.toThrow("reviewed access changed");

    expect(installSkill).toHaveBeenCalledOnce();
    expect(persistentMutation).not.toHaveBeenCalled();
  });
});
