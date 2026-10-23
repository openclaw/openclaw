import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import {
  buildEncodedPowerShellArgs,
  WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
} from "../infra/windows-powershell-spawn.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { execFileUtf8 } from "./exec-file.js";
import { SCHTASKS_TIMEOUT_MS } from "./schtasks-budget.js";
import { resolveServiceManagerEnv } from "./service-process-env.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

const SCHTASKS_NO_OUTPUT_TIMEOUT_MS = 30_000;

/** Runs Windows schtasks with bounded timeouts and normalized process results. */
export async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  assertGatewayServiceUpdateCurrent();
  const result = await runCommandWithTimeout(["schtasks", ...args], {
    baseEnv: resolveServiceManagerEnv(),
    timeoutMs: SCHTASKS_TIMEOUT_MS,
    noOutputTimeoutMs: SCHTASKS_NO_OUTPUT_TIMEOUT_MS,
  });
  const operation = [args[0], args.find((arg) => /^\/(?:DISABLE|ENABLE)$/i.test(arg))]
    .filter(Boolean)
    .join(" ");
  const timeoutDetail =
    result.termination === "timeout"
      ? `schtasks ${operation} timed out after ${SCHTASKS_TIMEOUT_MS}ms`
      : result.termination === "no-output-timeout"
        ? `schtasks ${operation} produced no output for ${SCHTASKS_NO_OUTPUT_TIMEOUT_MS}ms`
        : result.termination !== "exit"
          ? `schtasks ${operation} terminated before confirmed completion`
          : "";
  // schtasks can hang without output on some Windows hosts; convert both timeout
  // modes into ordinary process-like failures for service fallback logic.
  return {
    stdout: result.stdout,
    stderr: [timeoutDetail, result.stderr].filter(Boolean).join("\n"),
    code: result.termination === "exit" ? (result.code ?? 1) : result.code || 124,
  };
}

/** schtasks.exe discards the HRESULT; COM preserves it without parsing translated diagnostics. */
export async function execScheduledTaskEnabledChange(
  taskName: string,
  enabled: boolean,
): Promise<{ stdout: string; stderr: string; code: number; hresult?: number }> {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "try {",
    "$service=New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$task=$service.GetFolder('\\').GetTask($taskName)",
    `$task.Enabled=$${enabled ? "true" : "false"}`,
    "exit 0",
    "} catch {",
    "$exception=$_.Exception",
    "while($null -ne $exception.InnerException){$exception=$exception.InnerException}",
    "[Console]::Out.WriteLine($exception.HResult.ToString([Globalization.CultureInfo]::InvariantCulture))",
    "[Console]::Error.WriteLine($exception.Message)",
    "exit 1",
    "}",
  ].join("\n");
  const result = await execFileUtf8(
    getWindowsPowerShellExePath(),
    buildEncodedPowerShellArgs(script),
    {
      timeout: WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS,
    },
  );
  const nativeCode = result.stdout.trim();
  const hresult = Number(nativeCode);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    ...(result.termination === "exit" &&
    result.code === 1 &&
    /^-?\d+$/u.test(nativeCode) &&
    Number.isInteger(hresult) &&
    hresult >= -0x80000000 &&
    hresult <= 0x7fffffff
      ? { hresult }
      : {}),
  };
}
