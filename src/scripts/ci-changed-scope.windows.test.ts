import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";

// Each row reaches a separate Windows routing branch. Declared test inventory
// completeness is covered by test/package-scripts.test.ts.
describe("detectChangedScope Windows routing", () => {
  it.each([
    "src/infra/advertised-lan-host.test.ts",
    "src/agents/tools/media-tool-shared.test.ts",
    "src/daemon/schtasks-exec.ts",
    "src/auto-reply/usage-bar/template.ts",
    "src/media-understanding/attachments.cache.test.ts",
    "src/infra/home-display.ts",
    "src/infra/home-dir.test.ts",
    "src/agents/provider-local-service.shutdown.test.ts",
    "src/infra/openclaw-cli-invocation.test-support.ts",
    "test/helpers/openclaw-test-instance.cli.test-support.mjs",
    "src/plugin-sdk/node-host.ts",
    "packages/memory-host-sdk/src/host/explicit-extra-markdown.ts",
    "extensions/browser/src/browser/chrome.executable-probe.ts",
    "src/gateway/worker-environments/workspace-quiescence.ts",
    "src/shared/worker-bundle-archive.ts",
    "src/gateway/worker-environments/workspace-result-git.ts",
    "src/shared/pid-alive.ts",
    "scripts/lib/ci-windows-test-plan.mts",
    "src/cli/completion-runtime.ts",
    "src/state/openclaw-state-db.ts",
    "src/secrets/resolve.ts",
  ])("routes Windows proof for %s", (changedPath) => {
    expect(detectChangedScope([changedPath])).toMatchObject({ runNode: true, runWindows: true });
  });

  it.each([
    "src/cli/completion-runtime-extra.ts",
    "src/skills/runtime/refreshing.ts",
    "test/helpers/openclaw-test-instance-extra.test.ts",
    "src/secrets/resolve.test.ts",
  ])("keeps unrelated or non-Windows test owners off Windows: %s", (changedPath) => {
    expect(detectChangedScope([changedPath]).runWindows).toBe(false);
  });
});
