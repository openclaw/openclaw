import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  maybeRepairBundledPluginRuntimeDeps,
  scanBundledPluginRuntimeDeps,
} from "./doctor-bundled-plugin-runtime-deps.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
  };
}

function createPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
  return {
    confirm: vi.fn(),
    confirmAggressiveAutoFix: vi.fn(),
    confirmAutoFix: vi.fn().mockResolvedValue(true),
    confirmRuntimeRepair: vi.fn(),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      canPrompt: true,
      nonInteractive: false,
      shouldForce: false,
      shouldRepair: false,
      updateInProgress: false,
    },
    ...overrides,
  } as unknown as DoctorPrompter;
}

describe("doctor bundled plugin runtime deps", () => {
  it("skips source checkouts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "extensions"));
    writeJson(path.join(root, "dist", "extensions", "discord", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
      },
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports missing deps and conflicts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeJson(path.join(root, "dist", "extensions", "alpha", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
        "@scope/dep-two": "2.0.0",
      },
      optionalDependencies: {
        "dep-opt": "3.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "beta", "package.json"), {
      dependencies: {
        "dep-one": "1.0.0",
        "dep-conflict": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "gamma", "package.json"), {
      dependencies: {
        "dep-conflict": "2.0.0",
      },
    });

    writeJson(path.join(root, "node_modules", "dep-one", "package.json"), {
      name: "dep-one",
      version: "1.0.0",
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    const missing = result.missing.map((dep) => `${dep.name}@${dep.version}`);

    expect(missing).toEqual(["@scope/dep-two@2.0.0"]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.name).toBe("dep-conflict");
    expect(result.conflicts[0]?.versions).toEqual(["1.0.0", "2.0.0"]);
  });

  it("ignores optional deps when scanning bundled runtime deps", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeJson(path.join(root, "dist", "extensions", "discord", "package.json"), {
      dependencies: {
        opusscript: "0.1.1",
      },
      optionalDependencies: {
        "@discordjs/opus": "^0.10.0",
      },
    });

    writeJson(path.join(root, "node_modules", "opusscript", "package.json"), {
      name: "opusscript",
      version: "0.1.1",
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    expect(result.missing).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it("ignores required deps listed in pnpm.ignoredBuiltDependencies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), {
      name: "openclaw",
      pnpm: {
        ignoredBuiltDependencies: ["dep-ignored-native"],
      },
    });

    writeJson(path.join(root, "dist", "extensions", "alpha", "package.json"), {
      dependencies: {
        "dep-ignored-native": "1.0.0",
        "dep-required": "2.0.0",
      },
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    const missing = result.missing.map((dep) => `${dep.name}@${dep.version}`);

    expect(missing).toEqual(["dep-required@2.0.0"]);
  });

  it("hides ignored built dependency conflicts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), {
      name: "openclaw",
      pnpm: {
        ignoredBuiltDependencies: ["dep-ignored-native"],
      },
    });

    writeJson(path.join(root, "dist", "extensions", "alpha", "package.json"), {
      dependencies: {
        "dep-ignored-native": "1.0.0",
      },
    });
    writeJson(path.join(root, "dist", "extensions", "beta", "package.json"), {
      dependencies: {
        "dep-ignored-native": "2.0.0",
      },
    });

    const result = scanBundledPluginRuntimeDeps({ packageRoot: root });
    expect(result.conflicts).toEqual([]);
  });

  it("repairs only required deps for the Discord opus fallback case", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeJson(path.join(root, "dist", "extensions", "discord", "package.json"), {
      dependencies: {
        opusscript: "0.1.1",
      },
      optionalDependencies: {
        "@discordjs/opus": "^0.10.0",
      },
    });

    const confirmAutoFix = vi.fn().mockResolvedValue(true);
    const installDeps = vi.fn();

    await maybeRepairBundledPluginRuntimeDeps({
      installDeps,
      packageRoot: root,
      prompter: createPrompter({
        confirmAutoFix,
        shouldRepair: true,
      }),
      runtime: createRuntime(),
    });

    expect(confirmAutoFix).not.toHaveBeenCalled();
    expect(installDeps).toHaveBeenCalledTimes(1);
    expect(installDeps).toHaveBeenCalledWith({
      packageRoot: root,
      missingSpecs: ["opusscript@0.1.1"],
    });
  });

  it("skips repair when only optional deps are absent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-bundled-"));
    writeJson(path.join(root, "package.json"), { name: "openclaw" });

    writeJson(path.join(root, "dist", "extensions", "discord", "package.json"), {
      dependencies: {
        opusscript: "0.1.1",
      },
      optionalDependencies: {
        "@discordjs/opus": "^0.10.0",
      },
    });

    writeJson(path.join(root, "node_modules", "opusscript", "package.json"), {
      name: "opusscript",
      version: "0.1.1",
    });

    const confirmAutoFix = vi.fn().mockResolvedValue(true);
    const installDeps = vi.fn();

    await maybeRepairBundledPluginRuntimeDeps({
      installDeps,
      packageRoot: root,
      prompter: createPrompter({
        confirmAutoFix,
      }),
      runtime: createRuntime(),
    });

    expect(confirmAutoFix).not.toHaveBeenCalled();
    expect(installDeps).not.toHaveBeenCalled();
  });
});
