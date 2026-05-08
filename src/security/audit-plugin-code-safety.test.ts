import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectDeepCodeSafetyFindings } from "./audit-deep-code-safety.js";

const mocks = vi.hoisted(() => ({
  collectInstalledSkillsCodeSafetyFindings: vi.fn(),
  collectPluginsCodeSafetyFindings: vi.fn(),
}));

vi.mock("./audit.deep.runtime.js", () => ({
  collectInstalledSkillsCodeSafetyFindings: mocks.collectInstalledSkillsCodeSafetyFindings,
  collectPluginsCodeSafetyFindings: mocks.collectPluginsCodeSafetyFindings,
}));

describe("security audit plugin code safety gating", () => {
  beforeEach(() => {
    mocks.collectInstalledSkillsCodeSafetyFindings.mockReset();
    mocks.collectPluginsCodeSafetyFindings.mockReset();
    mocks.collectInstalledSkillsCodeSafetyFindings.mockResolvedValue([]);
    mocks.collectPluginsCodeSafetyFindings.mockResolvedValue([]);
  });

  it("skips plugin code safety findings when deep audit is disabled", async () => {
    const findings = await collectDeepCodeSafetyFindings({
      cfg: {},
      stateDir: "/tmp/openclaw-audit-deep-false-unused",
      deep: false,
    });

    expect(findings).toEqual([]);
    expect(mocks.collectPluginsCodeSafetyFindings).not.toHaveBeenCalled();
    expect(mocks.collectInstalledSkillsCodeSafetyFindings).not.toHaveBeenCalled();
  });

  it("starts plugin and skill code safety collectors in the same audit turn", async () => {
    let releasePluginCollector: (() => void) | undefined;
    mocks.collectPluginsCodeSafetyFindings.mockImplementation(
      () =>
        new Promise((resolve) => {
          releasePluginCollector = () =>
            resolve([
              {
                checkId: "plugins.code_safety",
                severity: "warn",
                title: "plugin finding",
                detail: "plugin detail",
              },
            ]);
        }),
    );
    mocks.collectInstalledSkillsCodeSafetyFindings.mockResolvedValue([
      {
        checkId: "skills.code_safety",
        severity: "warn",
        title: "skill finding",
        detail: "skill detail",
      },
    ]);

    const pending = collectDeepCodeSafetyFindings({
      cfg: {},
      stateDir: "/tmp/openclaw-audit-deep-concurrency-unused",
      deep: true,
    });

    try {
      await vi.waitFor(() =>
        expect(mocks.collectPluginsCodeSafetyFindings).toHaveBeenCalledTimes(1),
      );
      expect(mocks.collectInstalledSkillsCodeSafetyFindings).toHaveBeenCalledTimes(1);
    } finally {
      releasePluginCollector?.();
    }

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ checkId: "plugins.code_safety" }),
      expect.objectContaining({ checkId: "skills.code_safety" }),
    ]);
  });
});
