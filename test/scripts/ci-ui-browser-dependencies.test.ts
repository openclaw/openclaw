import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import * as workflow from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  "ui/src/pages/workboard/workboard-native-bundle.e2e.test.ts",
  "ui/src/e2e/tooltip-first-activation.e2e.test.ts",
  "ui/src/e2e/overlay-menu-swap-webkit.e2e.test.ts",
  "ui/src/e2e/logs-scroll.e2e.test.ts",
  "ui/src/e2e/chat-composer-picker-layout.e2e.test.ts",
  "ui/src/e2e/chat-history-reading-stability.e2e.test.ts",
  "ui/src/e2e/chat-loading-animation-retention.e2e.test.ts",
])("installs WebKit only for the shard owning %s", (suite) => {
  const root = tempDirs.make("openclaw-ui-browser-dependencies-");
  const local = (file: string) => path.join(root, file);
  const read = (file: string) => readFileSync(local(file), "utf8");
  const sibling = "ui/src/e2e/sibling.e2e.test.ts";
  const fixture = (file: string, content: string) => {
    mkdirSync(path.dirname(local(file)), { recursive: true });
    writeFileSync(local(file), content);
  };
  mkdirSync(local("bin"));
  fixture(
    ".ci-harness/.github/actions/setup-playwright-webkit/action.yml",
    readFileSync(".github/actions/setup-playwright-webkit/action.yml", "utf8"),
  );
  symlinkSync(path.resolve("node_modules"), local("node_modules"), "junction");
  for (const file of [suite, sibling]) {
    fixture(file, 'throw new Error("Discovery must not execute test bodies");\n');
  }
  const source = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  fixture(
    "test/vitest/vitest.ui-e2e.config.ts",
    `import { UiE2eSequencer } from ${source("test/vitest/vitest.ui-e2e.sequencer.ts")};
import { loadPatternListFromEnv } from ${source("test/vitest/vitest.pattern-file.ts")};
export default { test: {
  include: loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE") ?? ["ui/src/**/*.e2e.test.ts"],
  maxWorkers: 2, sequence: { sequencer: UiE2eSequencer },
} };\n`,
  );
  symlinkSync(
    path.resolve("test/vitest/vitest.pattern-file.ts"),
    local("test/vitest/vitest.pattern-file.ts"),
  );
  for (const [command, body] of [
    [
      "pnpm",
      'printf "%s\\n" "$*" >> "$UI_BROWSER_INSTALLS"; [ "$*" != "--dir ui exec which playwright" ] || echo playwright',
    ],
    ["playwright", 'printf "playwright %s\\n" "$*" >> "$UI_BROWSER_INSTALLS"'],
    ["node", 'printf "%s\\n" "$@" > "$UI_BROWSER_ARGS"'],
    // Keep the install's apt drop-in and mirror edits away from the host.
    ["id", "echo 1000"],
    [
      "sudo",
      '[ "$1" = -n ] && shift; [ "$1" = env ] && exec "$@"; [ "$1" != tee ] || cat > /dev/null',
    ],
  ] as const) {
    workflow.writeExecutable(local(`bin/${command}`), ["#!/bin/sh", body]);
  }
  writeFileSync(local("installs"), "");
  const run = (index: number, patterns?: string[]) => {
    writeFileSync(local("include.json"), JSON.stringify(patterns ?? []));
    const result = workflow.runControlUiE2eWorkflow({
      cwd: root,
      env: {
        ...process.env,
        PATH: `${local("bin")}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: "",
        OPENCLAW_VITEST_INCLUDE_FILE: patterns ? local("include.json") : "",
        OPENCLAW_VITEST_MAX_WORKERS: "3",
        VITEST_MAX_WORKERS: undefined,
        VITEST_SHARD_INDEX: String(index),
        VITEST_SHARD_COUNT: "2",
        UI_BROWSER_INSTALLS: local("installs"),
        UI_BROWSER_ARGS: local("args"),
      },
    });
    expect(result, result.stdout + result.stderr).toMatchObject({ status: 0, stderr: "" });
    const command = `scripts/run-vitest.mjs run --config test/vitest/vitest.ui-e2e.config.ts --configLoader runner --maxWorkers 3 --shard ${index}/2\n`;
    expect(read("args")).toBe(command.replaceAll(" ", "\n"));
  };
  run(1);
  run(2);
  expect(read("installs")).toBe(
    [
      "--dir ui exec which playwright",
      "playwright install-deps webkit",
      "--dir ui exec playwright install-deps webkit",
      "--dir ui exec playwright install webkit",
      "",
    ].join("\n"),
  );
  writeFileSync(local("installs"), "");
  run(1, [sibling]);
  expect(read("installs")).toBe("");
});

it.each([
  ["recovery", 0],
  ["fallback failure", 43],
] as const)("installs FRV WebKit through frozen Q: %s", (_scenario, fallbackExit) => {
  const root = tempDirs.make("openclaw-frv-webkit-");
  const local = (file: string) => path.join(root, file);
  const steps = workflow.readWorkflow(".github/workflows/openclaw-repo-e2e-reusable.yml").jobs.test
    .steps as workflow.WorkflowStep[];
  const checkout = workflow.requiredWorkflowStep(steps, "Checkout trusted artifact harness");
  const install = workflow.requiredWorkflowStep(
    steps,
    "Install Playwright WebKit for Control UI E2E",
  );
  const actionPath = ".github/actions/setup-playwright-webkit/action.yml";
  expect(checkout.with?.ref).toBe("${{ inputs.workflow_sha }}");
  expect(checkout.with?.repository).toBe("${{ inputs.workflow_repository }}");
  // Materialize only files admitted by Q's sparse checkout, not the selected target.
  const sparse = String(checkout.with?.["sparse-checkout"]).trim().split("\n");
  if (sparse.some((entry) => actionPath.startsWith(entry.slice(1)))) {
    const destination = local(path.join(String(checkout.with?.path), actionPath));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(actionPath, destination);
  }
  mkdirSync(path.dirname(local(actionPath)), { recursive: true });
  writeFileSync(
    local(actionPath),
    "runs:\n  using: composite\n  steps:\n    - name: Target must not own the installer\n      shell: bash\n      run: exit 99\n",
  );
  for (const [command, selected] of [
    ["pnpm test:ui:e2e --shard=4/4", true],
    ["pnpm test:e2e:gateway", false],
  ] as const) {
    expect(
      workflow.evaluateWorkflowCondition(install.if!, {
        eventName: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        matrix: { command },
      }),
    ).toBe(selected);
  }
  mkdirSync(local("bin"));
  mkdirSync(local("apt/apt.conf.d"), { recursive: true });
  mkdirSync(local("ui"));
  const mirrors = "https://slow.invalid/ubuntu\thigh\nhttps://fallback.invalid/ubuntu\tlow\n";
  writeFileSync(local("apt/apt-mirrors.txt"), mirrors);
  writeFileSync(local("events"), "");
  for (const [command, body] of [
    ["id", "echo 1000"],
    ["sudo", '[ "$1" = -n ]; shift; export ROOT_PHASE=1; exec "$@"'],
    [
      "timeout",
      '[ "$ROOT_PHASE" = 1 ]; [ "$1" = --kill-after=10s ]; shift; export DEADLINE="$1"; shift; exec "$@"',
    ],
    [
      "pnpm",
      '[ "${ROOT_PHASE:-0}" = 0 ]; [ "$PWD" = "$CASE_ROOT" ]; [ "$1 $2 $3" = "--dir ui exec" ]; shift 3; if [ "$*" = "which playwright" ]; then echo "$CASE_ROOT/ui/playwright"; else exec "$CASE_ROOT/ui/playwright" "${@:2}"; fi',
    ],
  ] as const) {
    workflow.writeExecutable(local("bin/" + command), ["#!/bin/bash", "set -euo pipefail", body]);
  }
  workflow.writeExecutable(local("ui/playwright"), [
    "#!/bin/bash",
    "set -euo pipefail",
    'config="$CASE_ROOT/apt/apt.conf.d/99openclaw-webkit-download-only"',
    'first=$(head -n1 "$CASE_ROOT/apt/apt-mirrors.txt" | cut -f1)',
    'case "$*" in',
    '  "install-deps webkit")',
    '    if [[ -f "$config" ]]; then',
    '      grep -q \'APT::Get::Download-Only "true";\' "$config"',
    '      echo "download $DEADLINE $first" >> "$CASE_ROOT/events"',
    '      [[ "$first" != *slow.invalid* ]] || exit 124',
    '      exit "$FALLBACK_EXIT"',
    "    fi",
    '    [[ -z "${DEADLINE:-}" ]]',
    '    echo "install $first" >> "$CASE_ROOT/events" ;;',
    '  "install webkit")',
    '    [[ ! -f "$config" ]]',
    '    [[ "$first" == https://slow.invalid/ubuntu ]]',
    '    echo browser >> "$CASE_ROOT/events" ;;',
    "  *) exit 86 ;;",
    "esac",
  ]);
  // Relocate only apt's filesystem boundary; execute the routed Q installer unchanged.
  const script = install.run ?? workflow.readPlaywrightWebkitInstall(install, root);
  const result = workflow.runWorkflowShellScript(
    script.replaceAll("/etc/apt/", local("apt") + path.sep),
    {
      cwd: root,
      tempDir: root,
      env: {
        ...process.env,
        PATH: local("bin") + path.delimiter + process.env.PATH,
        CASE_ROOT: root,
        FALLBACK_EXIT: String(fallbackExit),
      },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(fallbackExit);
  expect(readFileSync(local("events"), "utf8")).toBe(
    "download 120s https://slow.invalid/ubuntu\n" +
      "download 300s https://fallback.invalid/ubuntu\n" +
      (fallbackExit === 0 ? "install https://fallback.invalid/ubuntu\nbrowser\n" : ""),
  );
  expect(readFileSync(local("apt/apt-mirrors.txt"), "utf8")).toBe(mirrors);
  expect(existsSync(local("apt/apt.conf.d/99openclaw-webkit-download-only"))).toBe(false);
});
