import { expect, it } from "vitest";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import * as native from "./system-run-native-binary.test-helpers.js";

const DENIED_RUNTIME_APPROVAL = { ok: false, reason: "unsupported-command-shape" };
const MUTABLE_SCRIPT = "python ./mutable.py 'x&y'";
const posix = it.skipIf(process.platform === "win32");
function prepareShell(raw: string) {
  return buildSystemRunApprovalPlan({ command: ["/bin/sh", "-lc", raw], rawCommand: raw });
}

it.each([
  ["cmd.exe", "/d", "/c", "echo 'x&python mutable.py &echo '"],
  ["pwsh", "-NoProfile", "-Command", "Write-Output 'x&y'"],
  ["nu", "--commands", "echo 'x&y'"],
  ["bash", "-c", "echo 'x&y'"],
])("retains separator rejection outside node sh grammar: %j", (...command) => {
  expect(buildSystemRunApprovalPlan({ command })).toMatchObject(DENIED_RUNTIME_APPROVAL);
});

posix("preserves native shell literal arguments", ({ skip }) => {
  const binaryPath = native.resolveNativeBinaryFixturePath();
  if (native.canMutateNativeBinaryFixturePath(binaryPath)) {
    skip();
  }
  const callback = "http://127.0.0.1:9876/oauth2/callback?state=synthetic&code=synthetic";
  for (const [executable, argument] of [
    [binaryPath, "'" + callback + ";pipe|redirect<>$value`text`'"],
    [binaryPath, `"${callback}"`],
    [binaryPath, callback.replace("&", "\\&")],
    ["printf", `'${callback}'`],
  ]) {
    const command = `${executable} --auth-url ${argument}`;
    expect(prepareShell(command), command).toMatchObject({
      ok: true,
      plan: { argv: ["/bin/sh", "-lc", command], mutableFileOperand: undefined },
    });
  }
});

it
  .skipIf(process.platform === "win32")
  .each([
    ...[
      ...["&", ";", "&&", "|", ">", "<"].map((operator) => `safe${operator}other`),
      "safe\nother 'x&y'",
      "safe # ignored&literal",
      ...["\u000b", "\u00a0"].map((space) => `safe${space}#; other`),
      ...["''", '""'].map((quote) => `${quote}#; other`),
      ...["$(other)", "`other`", "${VALUE}"].map((expansion) => `"${expansion}&literal"`),
      "$(other) 'x&y'",
      '"$(/usr/bin/printf ""; /bin/sh /tmp/payload.sh)"',
      String.raw`\";other`,
      String.raw`"safe\";literal";other`,
      "'unterminated&literal",
      "'x&y' trailing\\",
    ].map((argument) => `printf ${argument}`),
    "py\\\nthon ./mutable.py 'x&y'",
    "\"py\\\nthon\" ./mutable.py 'x&y'",
    "pyth?n ./mutable.py 'x&y'",
    "env pyth*n ./mutable.py 'x&y'",
    "pnpm exec pyth?n ./mutable.py 'x&y'",
    "pnpm exec sh -c 'python ./mutable.py \"x&y\"'",
    "pnpm exec --shell-mode 'python ./mutable.py \"x&y\"'",
    "npm --script-shell ./mutable-shell exec -- /usr/bin/printf 'x&y'",
    "pnpm exec npm --script-shell ./mutable-shell exec -- /usr/bin/printf 'x&y'",
    "env -u '' python ./mutable.py 'x&y'",
    `(${MUTABLE_SCRIPT})`,
    ...["X=x", "!", "coproc", "command", "exec"].map((prefix) => `${prefix} ${MUTABLE_SCRIPT}`),
    "builtin eval \"python ./mutable.py 'x&y'\"",
    "trap 'python ./mutable.py \"x&y\"' EXIT",
    "enable -f ./mutable.so 'x&y'",
    ...["-v", "-[v]"].flatMap((flag) => [
      `printf ${flag} 'a[$(python ./mutable.py "x&y")]' %s value`,
      `test ${flag} 'a[$(python ./mutable.py "x&y")]'`,
    ]),
    ...["let", "declare"].map((builtin) => `${builtin} 'a[$(python ./mutable.py "x&y")]=1'`),
    "busybox sh -c 'python ./mutable.py \"x&y\"'",
  ])("rejects unsafe shell syntax and mutable-interpreter carriers: %j", (command) => {
  expect(prepareShell(command)).toMatchObject(DENIED_RUNTIME_APPROVAL);
});
