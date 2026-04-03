import { describe, expect, it } from "vitest";
import { buildWorkflowManifest } from "../../scripts/ci-write-manifest-outputs.mjs";

describe("buildWorkflowManifest", () => {
  it("builds static CI matrices from scope env", () => {
    const manifest = buildWorkflowManifest({
      GITHUB_EVENT_NAME: "pull_request",
      OPENCLAW_CI_DOCS_ONLY: "false",
      OPENCLAW_CI_DOCS_CHANGED: "false",
      OPENCLAW_CI_RUN_NODE: "true",
      OPENCLAW_CI_RUN_MACOS: "true",
      OPENCLAW_CI_RUN_ANDROID: "true",
      OPENCLAW_CI_RUN_WINDOWS: "true",
      OPENCLAW_CI_RUN_SKILLS_PYTHON: "false",
      OPENCLAW_CI_HAS_CHANGED_EXTENSIONS: "true",
      OPENCLAW_CI_CHANGED_EXTENSIONS_MATRIX: '{"include":[{"extension":"discord"}]}',
    });

    expect(manifest.run_checks).toBe(true);
    expect(manifest.checks_fast_matrix).toEqual({
      include: [
        { check_name: "checks-fast-bundled", runtime: "node", task: "bundled" },
        { check_name: "checks-fast-extensions", runtime: "node", task: "extensions" },
        {
          check_name: "checks-fast-contracts-protocol",
          runtime: "node",
          task: "contracts-protocol",
        },
      ],
    });
    expect(manifest.checks_matrix).toEqual({
      include: [
        { check_name: "checks-node-test", runtime: "node", task: "test" },
        { check_name: "checks-node-channels", runtime: "node", task: "channels" },
      ],
    });
    expect(manifest.checks_windows_matrix).toEqual({
      include: [{ check_name: "checks-windows-node-test", runtime: "node", task: "test" }],
    });
    expect(manifest.extension_fast_matrix).toEqual({
      include: [{ check_name: "extension-fast-discord", extension: "discord" }],
    });
    expect(manifest.android_matrix).toHaveProperty("include");
    expect(manifest.macos_node_matrix).toEqual({
      include: [{ check_name: "macos-node", runtime: "node", task: "test" }],
    });
  });

  it("includes the push-only compat lane on pushes", () => {
    const manifest = buildWorkflowManifest({
      GITHUB_EVENT_NAME: "push",
      OPENCLAW_CI_DOCS_ONLY: "false",
      OPENCLAW_CI_DOCS_CHANGED: "false",
      OPENCLAW_CI_RUN_NODE: "true",
    });

    expect(manifest.checks_matrix).toEqual({
      include: [
        { check_name: "checks-node-test", runtime: "node", task: "test" },
        { check_name: "checks-node-channels", runtime: "node", task: "channels" },
        {
          check_name: "checks-node-compat-node22",
          runtime: "node",
          task: "compat-node22",
          node_version: "22.x",
          cache_key_suffix: "node22",
        },
      ],
    });
  });

  it("suppresses heavy jobs for docs-only changes", () => {
    const manifest = buildWorkflowManifest({
      OPENCLAW_CI_DOCS_ONLY: "true",
      OPENCLAW_CI_DOCS_CHANGED: "true",
      OPENCLAW_CI_RUN_NODE: "true",
      OPENCLAW_CI_RUN_WINDOWS: "true",
    });

    expect(manifest.run_checks).toBe(false);
    expect(manifest.run_checks_windows).toBe(false);
    expect(manifest.run_check_docs).toBe(true);
  });

  it("builds install-smoke outputs separately", () => {
    const manifest = buildWorkflowManifest(
      {
        OPENCLAW_CI_DOCS_ONLY: "false",
        OPENCLAW_CI_RUN_CHANGED_SMOKE: "true",
      },
      "install-smoke",
    );

    expect(manifest).toEqual({
      docs_only: false,
      run_install_smoke: true,
    });
  });
});
