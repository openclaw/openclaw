import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
import path from "path";

// =========================
// TYPES
// =========================

export type ToolDefinition = {
  name: string;
};

export type ToolResult = {
  success: boolean;
  data: string;
};

// =========================
// PERSISTENT SHELL
// =========================

class PersistentShell {
  private proc: ChildProcess;
  private buffer = "";
  private busy = false;

  constructor(private shellType: "bash" | "powershell") {
    this.proc =
      shellType === "powershell"
        ? spawn("powershell.exe", [], { stdio: "pipe" })
        : spawn("bash", [], { stdio: "pipe" });

    this.proc.stdout?.on("data", (d: Buffer) => {
      this.buffer += d.toString();
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      this.buffer += d.toString();
    });
  }

  async run(command: string, timeout = 15000): Promise<string> {
    if (this.busy) {
      return "ERROR: shell busy";
    }

    this.busy = true;

    return new Promise((resolve) => {
      const marker = `__END_${Date.now()}__`;

      const full =
        this.shellType === "powershell"
          ? `${command}; echo ${marker}\n`
          : `${command}\necho ${marker}\n`;

      this.proc.stdin?.write(full);

      const start = Date.now();

      const check = () => {
        if (this.buffer.includes(marker)) {
          const [out] = this.buffer.split(marker);
          this.buffer = "";
          this.busy = false;
          resolve(out.trim());
          return;
        }

        if (Date.now() - start > timeout) {
          this.busy = false;
          resolve("ERROR: timeout");
          return;
        }

        setTimeout(check, 20);
      };

      check();
    });
  }
}

// =========================
// TOOL RUNTIME
// =========================

export class ToolRuntime {
  private tools: Map<string, ToolDefinition>;
  private shell: PersistentShell;
  private cwd: string;

  constructor(tools: ToolDefinition[]) {
    this.tools = new Map(tools.map((t) => [t.name, t]));

    const shellType = process.platform === "win32" ? "powershell" : "bash";

    this.shell = new PersistentShell(shellType);
    this.cwd = process.cwd();
  }

  // =========================
  // HELPERS
  // =========================

  /** Liest einen string-Wert aus args, sonst leeren String */
  private str(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
  }

  private ok(data: string): ToolResult {
    return {
      success: true,
      data: `FINAL_RESULT:\n${data}`,
    };
  }

  private error(msg: string): ToolResult {
    return {
      success: false,
      data: `FINAL_RESULT:\nERROR: ${msg}`,
    };
  }

  // =========================
  // MAIN ENTRY (OPENCLAW CONTRACT)
  // =========================
  async run(name: string, args: Record<string, unknown>, _callId?: string): Promise<ToolResult> {
    if (!this.tools.has(name)) {
      return this.error(`TOOL_NOT_ALLOWED:${name}`);
    }

    try {
      switch (name) {
        case "shell":
          return this.ok(await this.runShell(args));

        case "write":
          return this.ok(await this.writeFile(args));

        case "ls":
          return this.ok(await this.listDir(args));

        case "cd":
          return this.ok(await this.changeDir(args));

        case "python":
          return this.ok(await this.runPython(args));

        default:
          return this.error(`UNKNOWN_TOOL:${name}`);
      }
    } catch (err: unknown) {
      return this.error((err as Error)?.message || String(err));
    }
  }

  // =========================
  // SHELL
  // =========================

  private async runShell(args: Record<string, unknown>): Promise<string> {
    const command = this.str(args?.command).trim();

    if (!command) {
      throw new Error("empty command");
    }

    const full = `cd "${this.cwd}"\n${command}`;
    return await this.shell.run(full);
  }

  // =========================
  // WRITE
  // =========================

  private async writeFile(args: Record<string, unknown>): Promise<string> {
    const filePath = path.resolve(this.cwd, this.str(args?.path));
    const content = this.str(args?.content);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");

    return "OK";
  }

  // =========================
  // LS
  // =========================

  private async listDir(args: Record<string, unknown>): Promise<string> {
    const dir = path.resolve(this.cwd, this.str(args?.path, "."));
    const files = await fs.readdir(dir);

    return files.join("\n");
  }

  // =========================
  // CD
  // =========================

  private async changeDir(args: Record<string, unknown>): Promise<string> {
    const target = path.resolve(this.cwd, this.str(args?.path));

    const stat = await fs.stat(target);

    if (!stat.isDirectory()) {
      throw new Error("not a directory");
    }

    this.cwd = target;
    return this.cwd;
  }

  // =========================
  // PYTHON
  // =========================

  private async runPython(args: Record<string, unknown>): Promise<string> {
    const code = this.str(args?.code);

    if (!code) {
      throw new Error("empty code");
    }

    return new Promise((resolve) => {
      const proc = spawn("python", ["-c", code], {
        cwd: this.cwd,
      });

      let out = "";

      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.stderr?.on("data", (d) => (out += d.toString()));

      proc.on("close", () => {
        resolve(out.trim());
      });
    });
  }
}
