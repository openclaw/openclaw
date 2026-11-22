import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";

export function formatUpdateReportReadHint(reportPath: string): string {
  return process.platform === "win32"
    ? `Read report (PowerShell): Get-Content -LiteralPath ${quotePowerShellArg(reportPath)}`
    : `Read report (shell): cat -- ${quoteCliArg(reportPath)}`;
}
