import { expect, it } from "vitest";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import {
  canMutateNativeBinaryFixturePath,
  resolveNativeBinaryFixturePath,
} from "./system-run-native-binary.test-helpers.js";

const DENIED_RUNTIME_APPROVAL = expect.objectContaining({
  ok: false,
  reason: "unsupported-command-shape",
});
function prepareShell(command: string) {
  return buildSystemRunApprovalPlan({
    command: ["/bin/sh", "-lc", command],
    rawCommand: command,
    cwd: process.cwd(),
  });
}

it.each([
  ["cmd.exe", "/d", "/c", "echo 'x&python mutable.py &echo '"],
  ["pwsh", "-NoProfile", "-Command", "Write-Output 'x&y'"],
  ["nu", "--commands", "echo 'x&y'"],
  ["zsh", "-c", "noglob python ./mutable.py 'x&y'"],
  ["bash", "-c", "echo 'x&y'"],
])("retains separator rejection outside node sh grammar: %j", (...command) => {
  expect(buildSystemRunApprovalPlan({ command, cwd: process.cwd() })).toEqual(
    DENIED_RUNTIME_APPROVAL,
  );
});

it.skipIf(process.platform === "win32")("preserves native shell literal arguments", ({ skip }) => {
  const binaryPath = resolveNativeBinaryFixturePath();
  if (canMutateNativeBinaryFixturePath(binaryPath)) {
    skip();
  }
  const callback = "http://127.0.0.1:9876/oauth2/callback?state=synthetic&code=synthetic";
  for (const [executable, argument] of [
    [binaryPath, `'${callback}'`],
    [binaryPath, `"${callback}"`],
    [binaryPath, callback.replace("&", "\\&")],
    [binaryPath, "'literal;pipe|redirect<>$value`text`'"],
    [binaryPath, '"literal;pipe|redirect<>"'],
    ["printf", `'${callback}'`],
  ]) {
    const command = `${executable} --auth-url ${argument}`;
    expect(prepareShell(command), command).toMatchObject({
      ok: true,
      plan: { argv: ["/bin/sh", "-lc", command], mutableFileOperand: undefined },
    });
  }
});

it.skipIf(process.platform === "win32")(
  "rejects shell control, expansions and malformed payloads",
  () => {
    const binaryPath = resolveNativeBinaryFixturePath();
    for (const argument of [
      ...["&", ";", "&&", "|", ">", "<"].map((operator) => `safe${operator}other`),
      "safe\nother 'x&y'",
      "safe # comment\nother 'x&y'",
      "safe # ignored&literal",
      ...["\u000b", "\u00a0"].map((space) => `safe${space}#; other`),
      "''#; other",
      '""#; other',
      "''#$(other) 'x&y'",
      '""#`other` &other',
      ...["$(other)", "`other`", "${VALUE}"].map((expansion) => `"${expansion}&literal"`),
      "$(other) 'x&y'",
      String.raw`\";other`,
      String.raw`"safe\";literal";other`,
      '"a&b$(other)"',
      '"$(/usr/bin/printf ""; /bin/sh /tmp/payload.sh)"',
      "\"$(/usr/bin/printf 'a|b')\"",
      "`/usr/bin/printf 'a'; /usr/bin/printf 'b'`",
      "'unterminated&literal",
      "'x&y' trailing\\",
    ]) {
      const command = `${binaryPath} ${argument}`;
      expect(prepareShell(command), command).toEqual(DENIED_RUNTIME_APPROVAL);
    }
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
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
    "(python ./mutable.py 'x&y')",
    "X=x python ./mutable.py 'x&y'",
    "! python ./mutable.py 'x&y'",
    "coproc python ./mutable.py 'x&y'",
    "command python ./mutable.py 'x&y'",
    "exec python ./mutable.py 'x&y'",
    "builtin eval \"python ./mutable.py 'x&y'\"",
    "trap 'python ./mutable.py \"x&y\"' EXIT",
    "enable -f ./mutable.so 'x&y'",
    "printf -v 'a[$(python ./mutable.py \"x&y\")]' %s value",
    "printf -[v] 'a[$(python ./mutable.py \"x&y\")]' %s value",
    "test -v 'a[$(python ./mutable.py \"x&y\")]'",
    "test -[v] 'a[$(python ./mutable.py \"x&y\")]'",
    "let 'a[$(python ./mutable.py \"x&y\")]=1'",
    "declare 'a[$(python ./mutable.py \"x&y\")]=1'",
    "busybox sh -c 'python ./mutable.py \"x&y\"'",
  ])("rejects shell syntax and carriers that obscure mutable interpreters: %j", (command) => {
  expect(prepareShell(command)).toEqual(DENIED_RUNTIME_APPROVAL);
});
