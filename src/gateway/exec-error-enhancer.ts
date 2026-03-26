/**
 * Enhanced error messages for exec tool
 * Provides helpful suggestions for common blockers and missing tools
 */

export interface EnhancedExecError {
  code: string;
  message: string;
  suggestion?: string;
  installCommand?: string;
  allowlistSuggestion?: string;
}

const COMMON_COMMANDS = {
  git: {
    name: "Git",
    installMac: "brew install git",
    installLinux: "apt-get install git",
    elevatedRisks: ["push", "reset", "clean"],
  },
  npm: {
    name: "npm",
    installMac: "brew install node",
    installLinux: "apt-get install npm",
    elevatedRisks: ["install", "uninstall", "global"],
  },
  brew: {
    name: "Homebrew",
    installMac: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    installLinux: "Not available on Linux",
    elevatedRisks: ["install", "uninstall", "update"],
  },
  docker: {
    name: "Docker",
    installMac: "brew install docker",
    installLinux: "apt-get install docker.io",
    elevatedRisks: ["run", "rmi", "volume"],
  },
  python: {
    name: "Python",
    installMac: "brew install python3",
    installLinux: "apt-get install python3",
    elevatedRisks: ["pip", "install"],
  },
  node: {
    name: "Node.js",
    installMac: "brew install node",
    installLinux: "apt-get install nodejs",
    elevatedRisks: [],
  },
};

export class ExecErrorEnhancer {
  /**
   * Enhance error message with helpful suggestions
   */
  enhance(command: string, error: string, errorCode?: string): EnhancedExecError {
    const baseCommand = this.extractBaseCommand(command);
    const commonTool = this.identifyCommonTool(baseCommand);

    if (error.includes("command not found")) {
      if (commonTool) {
        const toolInfo = COMMON_COMMANDS[commonTool as keyof typeof COMMON_COMMANDS];
        return {
          code: "COMMAND_NOT_FOUND",
          message: `${toolInfo.name} is not installed.`,
          suggestion: `Install ${toolInfo.name} with: ${toolInfo.installMac}`,
          installCommand: toolInfo.installMac,
          allowlistSuggestion: `Once installed, add '${baseCommand}' to your exec allowlist for faster execution.`,
        };
      }
      return {
        code: "COMMAND_NOT_FOUND",
        message: `Command '${baseCommand}' not found.`,
        suggestion: "Ensure the tool is installed and in your PATH.",
        allowlistSuggestion: "Once available, you can add it to the exec allowlist.",
      };
    }

    if (error.includes("permission denied")) {
      const isElevatedCommand = commonTool && this.isElevatedCommand(command, commonTool);
      return {
        code: "PERMISSION_DENIED",
        message: `Permission denied executing '${baseCommand}'.`,
        suggestion: isElevatedCommand
          ? `This appears to be a privileged operation. Use '/approve ${command}' to request approval.`
          : "Check file permissions or try with elevated privileges.",
        allowlistSuggestion:
          "Add this command to the allowlist to skip approval for repeated execution.",
      };
    }

    if (error.includes("EACCES") || error.includes("access denied")) {
      return {
        code: "ACCESS_DENIED",
        message: `Access denied: insufficient permissions to execute '${baseCommand}'.`,
        suggestion: `Try: /approve ${command}`,
        allowlistSuggestion: "Once approved, you can whitelist this command to avoid repeated approvals.",
      };
    }

    if (error.includes("ENOENT")) {
      return {
        code: "NOT_FOUND",
        message: `File or path not found in command '${command}'.`,
        suggestion: "Check that all paths and tools referenced in the command exist.",
      };
    }

    // Generic error
    return {
      code: errorCode || "EXEC_ERROR",
      message: error,
      suggestion: `Try: /approve ${command}`,
      allowlistSuggestion: `If this is a trusted command, add it to exec.allowlist to skip approval.`,
    };
  }

  private extractBaseCommand(command: string): string {
    const trimmed = command.trim();
    const parts = trimmed.split(/\s+/);
    return parts[0] || command;
  }

  private identifyCommonTool(baseCommand: string): string | null {
    const normalized = baseCommand.toLowerCase();
    for (const [tool] of Object.entries(COMMON_COMMANDS)) {
      if (normalized.includes(tool)) {
        return tool;
      }
    }
    return null;
  }

  private isElevatedCommand(command: string, tool: string): boolean {
    const toolInfo = COMMON_COMMANDS[tool as keyof typeof COMMON_COMMANDS];
    if (!toolInfo) {
      return false;
    }
    const elevated = toolInfo.elevatedRisks;
    return elevated.some((risk) => command.toLowerCase().includes(risk));
  }
}
