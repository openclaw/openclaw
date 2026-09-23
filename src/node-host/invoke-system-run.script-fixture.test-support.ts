import path from "node:path";

export function createMutableScriptOperandFixture(tmp: string): {
  command: string[];
  scriptPath: string;
  initialBody: string;
  changedBody: string;
} {
  if (process.platform === "win32") {
    const scriptPath = path.join(tmp, "run.js");
    return {
      command: [process.execPath, "./run.js"],
      scriptPath,
      initialBody: 'console.log("SAFE");\n',
      changedBody: 'console.log("PWNED");\n',
    };
  }
  const scriptPath = path.join(tmp, "run.sh");
  return {
    command: ["/bin/sh", "./run.sh"],
    scriptPath,
    initialBody: "#!/bin/sh\necho SAFE\n",
    changedBody: "#!/bin/sh\necho PWNED\n",
  };
}

export function createRuntimeScriptOperandFixture(
  tmp: string,
  runtime: "bun" | "deno" | "jiti" | "tsx",
): {
  command: string[];
  scriptPath: string;
  initialBody: string;
  changedBody: string;
} {
  const scriptPath = path.join(tmp, "run.ts");
  const initialBody = 'console.log("SAFE");\n';
  const changedBody = 'console.log("PWNED");\n';
  switch (runtime) {
    case "bun":
      return {
        command: ["bun", "run", "./run.ts"],
        scriptPath,
        initialBody,
        changedBody,
      };
    case "deno":
      return {
        command: ["deno", "run", "-A", "--allow-read", "--", "./run.ts"],
        scriptPath,
        initialBody,
        changedBody,
      };
    case "jiti":
      return {
        command: ["jiti", "./run.ts"],
        scriptPath,
        initialBody,
        changedBody,
      };
    case "tsx":
      return {
        command: ["tsx", "./run.ts"],
        scriptPath,
        initialBody,
        changedBody,
      };
  }
  const unsupportedRuntime: never = runtime;
  throw new Error(`unsupported runtime fixture: ${String(unsupportedRuntime)}`);
}
