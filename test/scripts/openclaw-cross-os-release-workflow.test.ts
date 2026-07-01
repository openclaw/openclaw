// Openclaw Cross Os Release Workflow tests cover openclaw cross os release workflow script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const WRAPPER_PATH = "scripts/github/run-openclaw-cross-os-release-checks.sh";
const HARNESS = "bash workflow/scripts/github/run-openclaw-cross-os-release-checks.sh";

describe("cross-OS release checks workflow", () => {
  it("runs the TypeScript release harness through the Windows-safe wrapper", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain(HARNESS);
    expect(workflow).toContain("suite_filter:");
    expect(workflow).toContain('--suite-filter "${INPUT_SUITE_FILTER}"');
    expect(workflow).not.toContain('pnpm dlx "tsx@${TSX_VERSION}"');
  });

  it("bounds npm baseline packing during prepare", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("timeout --preserve-status 300s npm pack --ignore-scripts");
  });

  it("keeps release artifact tarball filenames local before upload paths use them", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow.match(/function resolveTarballFileName/g)).toHaveLength(2);
    expect(workflow.match(/path\.win32\.basename\(fileName\)/g)).toHaveLength(2);
    expect(workflow).toContain("candidate_file_name");
    expect(workflow).toContain("Baseline npm pack filename");
    expect(workflow).toContain("fileName !== path.basename(fileName)");
    expect(workflow).toContain("fileName !== path.win32.basename(fileName)");
    expect(workflow).toContain("process.stdout.write(`file_name=${fileName}\\n`);");
  });

  it("uses Windows-safe npm resolution for the TypeScript loader bootstrap", () => {
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");

    expect(wrapper).toContain("command -v npm.cmd");
    expect(wrapper).toContain('npm_tool_dir="$(cygpath -w "${tool_dir}")"');
    expect(wrapper).toContain('npm_cli_arg="$(cygpath -w "${npm_cli_js}")"');
    expect(wrapper).toContain('loader_arg="$(cygpath -w "${loader_path}")"');
    expect(wrapper).toContain('"${node_cmd}" "${npm_cli_arg}" install --prefix "${npm_tool_dir}"');
    expect(wrapper).toContain('"${npm_cmd}" install --prefix "${npm_tool_dir}"');
    expect(wrapper).toContain('exec "${node_cmd}" --import "${loader_url}"');
  });
});
