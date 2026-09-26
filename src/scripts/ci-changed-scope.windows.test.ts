// Windows CI scope tests cover paths with platform-specific runtime contracts.
import { describe, expect, it } from "vitest";

const { detectChangedScope } = await import("../../scripts/ci-changed-scope.mjs");

// test/package-scripts.test.ts covers every declared Windows test target.
describe("detectChangedScope Windows routing", () => {
  it("routes completion profile installation to Windows", () => {
    expect(detectChangedScope(["src/cli/completion-runtime.ts"])).toMatchObject({
      runNode: true,
      runWindows: true,
    });
    expect(detectChangedScope(["src/cli/completion-runtime-extra.ts"]).runWindows).toBe(false);
  });

  it("routes the Canvas pnpm runner to Windows", () => {
    expect(detectChangedScope(["extensions/canvas/scripts/pnpm-runner.mjs"])).toMatchObject({
      runNode: true,
      runWindows: true,
    });

    expect(detectChangedScope(["extensions/canvas/src/a2ui-jsonl.ts"]).runWindows).toBe(false);
  });

  it("routes the Windows Testbox admission owner, caller, and native proof", () => {
    for (const changedPath of [
      "scripts/windows-testbox-openssh.ps1",
      ".github/workflows/windows-blacksmith-testbox.yml",
      "test/scripts/windows-blacksmith-testbox.test.ts",
    ]) {
      expect(detectChangedScope([changedPath]), changedPath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
    expect(detectChangedScope(["scripts/windows-testbox-openssh-extra.ps1"]).runWindows).toBe(
      false,
    );
    expect(
      detectChangedScope([".github/workflows/windows-blacksmith-testbox-extra.yml"]).runWindows,
    ).toBe(false);
  });

  it("routes source CLI invocation owners and their native proof to Windows", () => {
    for (const sourceCliPath of [
      "src/infra/openclaw-cli-invocation.ts",
      "src/infra/openclaw-cli-invocation.test.ts",
      "src/infra/openclaw-cli-invocation.test-support.ts",
      "src/infra/openclaw-cli-shim.ts",
      "src/infra/openclaw-cli-shim.test.ts",
    ]) {
      expect(detectChangedScope([sourceCliPath]), sourceCliPath).toMatchObject({
        runNode: true,
        runWindows: true,
        runMacos: false,
        runAndroid: false,
      });
    }

    for (const unrelatedPath of [
      "src/infra/openclaw-root.ts",
      "src/infra/openclaw-cli-other.test.ts",
      "src/infra/openclaw-cli-shim-extra.ts",
    ]) {
      expect(detectChangedScope([unrelatedPath]).runWindows, unrelatedPath).toBe(false);
    }
  });

  for (const { name, paths } of [
    {
      name: "routes worker bundle producers, archives, installers, and regression coverage to Windows",
      paths: [
        "src/shared/worker-bundle-archive.ts",
        "src/shared/worker-bundle-hash.ts",
        "src/gateway/worker-environments/bundle.ts",
        "src/gateway/worker-environments/bundle.test.ts",
        "src/gateway/worker-environments/bundle-staging.ts",
        "src/node-host/node-worker-bundle-installer.ts",
      ],
    },
    {
      name: "routes paired-worker workspace transfer owners and native regression coverage to Windows",
      paths: [
        "src/infra/git-exec.ts",
        "src/agents/worktrees/git.ts",
        "src/agents/worktrees/base-ref.ts",
        "src/gateway/worker-environments/workspace-result-git.ts",
        "src/gateway/worker-environments/workspace-result-git.test.ts",
        "src/gateway/worker-environments/workspace-result-staging.ts",
        "src/gateway/worker-environments/session-repository-checkpoints.ts",
        "src/gateway/worker-environments/session-repository-checkpoints.test.ts",
        "src/node-host/node-worker-transfer-client.ts",
        "src/gateway/worker-environments/node-worker-tunnel.ts",
        "src/gateway/worker-environments/node-worker-tunnel.test.ts",
        "src/gateway/worker-environments/workspace-sync-scripts.ts",
        "src/gateway/worker-environments/workspace-sync-manifest.test.ts",
      ],
    },
    {
      name: "routes SQLite transcript archive changes to Windows",
      paths: [
        "src/config/sessions/session-accessor.sqlite-archive.ts",
        "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      ],
    },
    {
      // Native process identity proof must also run when its consumers change.
      name: "routes process-start identity and every consumer of it to Windows",
      paths: [
        "src/shared/pid-alive.ts",
        "src/infra/windows-process-start.ts",
        "src/infra/gateway-lock.ts",
        "src/node-host/node-worker-process-identity.ts",
        "src/cron/store/run-receipt-store.ts",
      ],
    },
    {
      name: "routes core SQLite state changes to Windows",
      paths: [
        "src/commands/doctor-sqlite-compact.ts",
        "src/infra/node-sqlite.ts",
        "src/infra/update-managed-service-handoff.ts",
        "src/state/openclaw-state-db.ts",
      ],
    },
    {
      name: "routes the OpenSSH resolver and its native proof to Windows",
      paths: ["src/infra/ssh-client.ts"],
    },
    {
      name: "routes port diagnostics and their native proof to Windows",
      paths: ["src/infra/ports-inspect.ts"],
    },
    {
      name: "routes LAN advertisement and its native PowerShell proof to Windows",
      paths: ["src/infra/advertised-lan-host.ts", "src/infra/advertised-lan-host.test.ts"],
    },
    {
      name: "routes MXC runtime changes and Windows-only suites to Windows",
      paths: ["extensions/mxc/src/mxc-backend.ts"],
    },
    {
      name: "routes exec script preflight changes and Windows-only coverage to Windows",
      paths: [
        "src/agents/bash-tools.exec-script-preflight.ts",
        "src/agents/bash-tools.exec-script-target.ts",
      ],
    },
    {
      name: "routes exec allowlist matcher changes and Windows-only coverage to Windows",
      paths: ["src/infra/exec-allowlist-pattern.ts"],
    },
    {
      name: "routes safe removal changes and Windows-only coverage to Windows",
      paths: ["src/infra/fs-safe-remove.ts"],
    },
    {
      name: "routes web and Teams file URL handling to Windows",
      paths: [
        "src/agents/tools/media-tool-shared.test.ts",
        "src/agents/tools/media-tool-shared.ts",
        "src/agents/tools/pdf-tool.test.ts",
        "src/agents/tools/pdf-tool.ts",
        "src/media/local-media-path.ts",
        "src/media/local-roots.ts",
        "src/media/local-roots.test.ts",
        "src/media/web-media.ts",
        "src/channels/inbound-event/media.ts",
        "src/channels/inbound-event/media.test.ts",
        "src/gateway/managed-image-attachments.ts",
        "src/gateway/managed-image-attachments.test.ts",
        "extensions/msteams/src/media-helpers.ts",
      ],
    },
    {
      name: "routes sandbox media staging file URL handling to Windows",
      paths: ["src/auto-reply/reply/stage-sandbox-media.ts"],
    },
    {
      name: "routes usage footer template changes and native coverage to Windows",
      paths: ["src/auto-reply/usage-bar/template.ts"],
    },
    {
      name: "routes media-understanding file URL changes and native coverage to Windows",
      paths: [
        "src/media-understanding/attachments.cache.ts",
        "src/media-understanding/attachments.cache.test.ts",
        "src/media-understanding/attachments.normalize.ts",
        "src/media-understanding/attachments.normalize.test.ts",
      ],
    },
    {
      name: "routes shared home display owners and visible command coverage to Windows",
      paths: [
        "src/utils.ts",
        "src/infra/home-display.ts",
        "src/infra/path-guards.ts",
        "src/commands/agents.commands.list.ts",
        "src/cli/daemon-cli/status.print.ts",
        "packages/terminal-core/src/display-string.ts",
        "src/agents/sandbox/fs-paths.ts",
        "src/agents/sessions/tools/render-utils.ts",
      ],
    },
    {
      name: "routes OS-home path owners and native tool coverage to Windows",
      paths: [
        "src/infra/home-dir.ts",
        "src/infra/home-dir.test.ts",
        "src/agents/agent-tools.read.ts",
        "src/agents/sessions/tools/path-utils.ts",
      ],
    },
    {
      name: "routes child environment resolution and native doctor coverage to Windows",
      paths: [
        "src/agents/provider-local-service.ts",
        "src/agents/provider-local-service-process.ts",
        "src/agents/provider-local-service.env-case.test.ts",
        "src/agents/provider-local-service.shutdown.test.ts",
        "src/agents/provider-local-service.settlement.test.ts",
        "src/cli/mcp-cli.ts",
        "src/cli/mcp-cli.test.ts",
        "src/infra/process-env.ts",
      ],
    },
    {
      name: "routes node-host executable resolution and native coverage to Windows",
      paths: ["src/plugin-sdk/node-host.ts", "src/tui/tui.ts"],
    },
    {
      name: "routes explicit memory extra-file owners and native coverage to Windows",
      paths: [
        "packages/memory-host-sdk/src/host/explicit-extra-markdown.ts",
        "packages/memory-host-sdk/src/host/internal.ts",
        "packages/memory-host-sdk/src/host/internal.test.ts",
        "packages/memory-host-sdk/src/host/read-file.ts",
        "extensions/memory-core/src/cli-runtime-common.ts",
      ],
    },
    {
      name: "routes workspace quiescence owners and native coverage to Windows",
      paths: [
        "src/gateway/worker-environments/workspace-quiescence.ts",
        "src/gateway/worker-environments/workspace-quiescence-scripts.ts",
        "src/gateway/worker-environments/workspace-quiescence.test.ts",
      ],
    },
    {
      name: "routes SecretRef path-security changes and focused owner coverage to Windows",
      paths: [
        "src/commands/doctor-gateway-auth-token.ts",
        "src/flows/doctor-core-checks.ts",
        "src/flows/doctor-health-contributions.ts",
        "src/gateway/auth-token-resolution.ts",
        "src/gateway/resolve-configured-secret-input-string.ts",
        "src/infra/fs-safe.ts",
        "src/infra/boundary-file-read.ts",
        "src/secrets/resolve-errors.ts",
        "src/secrets/resolve.ts",
        "src/security/audit-fs.ts",
      ],
    },
  ]) {
    it(name, () => {
      for (const changedPath of paths) {
        expect(detectChangedScope([changedPath]), changedPath).toMatchObject({
          runNode: true,
          runWindows: true,
        });
      }
    });
  }

  it("routes shared test-state and process fixture owners to Windows", () => {
    for (const fixturePath of [
      "test/vitest/vitest.shared.config.ts",
      "src/test-utils/openclaw-test-state.ts",
      "test/helpers/openclaw-test-instance.ts",
      "test/helpers/openclaw-test-instance.cli.test-support.mjs",
      "scripts/lib/managed-child-process.mts",
      "scripts/lib/vitest-resource-ownership.mts",
    ]) {
      expect(detectChangedScope([fixturePath]), fixturePath).toMatchObject({
        runNode: true,
        runWindows: true,
      });
    }
    expect(detectChangedScope(["test/helpers/promise.ts"]).runWindows).toBe(false);
    expect(
      detectChangedScope(["test/helpers/openclaw-test-instance-extra.test.ts"]).runWindows,
    ).toBe(false);
  });

  it("does not route SecretRef tests owned by non-Windows lanes", () => {
    for (const testPath of [
      "src/gateway/resolve-configured-secret-input-string.test.ts",
      "src/infra/fs-safe-defaults.test.ts",
      "src/secrets/resolve.test.ts",
      "test/e2e/qa-lab/runtime/doctor-auth-secretref-checks.e2e.test.ts",
    ]) {
      expect(detectChangedScope([testPath]).runWindows, testPath).toBe(false);
    }
  });
});
