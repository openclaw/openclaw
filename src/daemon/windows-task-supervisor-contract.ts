/** Internal argument used by generated Windows Gateway service launchers. */
export const WINDOWS_TASK_SUPERVISOR_FLAG = "--task-supervisor";

/** The install preference becomes a consumed runtime marker only inside the hidden launcher. */
export const WINDOWS_TASK_LAUNCHER_ENV = "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER";
export const WINDOWS_TASK_LAUNCHER_ACTIVE = "wscript";

/** Internal argument marking the Gateway child owned by the task supervisor. */
export const WINDOWS_TASK_SUPERVISOR_CHILD_FLAG = "--task-supervisor-child";

export const WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN = 0x1_0000;
export const WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX = 0x7fff_ffff;

export function isWindowsTaskSupervisorChildArgument(argument: string): boolean {
  return (
    argument === WINDOWS_TASK_SUPERVISOR_CHILD_FLAG ||
    argument.startsWith(`${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=`)
  );
}

export function formatWindowsTaskSupervisorChildArgument(exitCode: number): string {
  return `${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=${exitCode}`;
}

export function readWindowsTaskSupervisorRestartExitCode(
  argv: readonly string[],
): number | undefined {
  const matches = argv.filter(isWindowsTaskSupervisorChildArgument);
  if (matches.length !== 1 || matches[0] === WINDOWS_TASK_SUPERVISOR_CHILD_FLAG) {
    return undefined;
  }
  const raw = matches[0]?.slice(WINDOWS_TASK_SUPERVISOR_CHILD_FLAG.length + 1);
  if (!raw || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const exitCode = Number(raw);
  return Number.isSafeInteger(exitCode) &&
    exitCode >= WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MIN &&
    exitCode <= WINDOWS_TASK_SUPERVISOR_RESTART_EXIT_CODE_MAX
    ? exitCode
    : undefined;
}
