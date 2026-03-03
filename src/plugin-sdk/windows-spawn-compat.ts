/**
 * Guarded re-exports of the windows-spawn helpers.
 *
 * When the plugin-sdk dist was built without the windows-spawn module
 * (see #33514), these wrappers fall back to safe direct-passthrough
 * implementations so that extensions never crash at import time.
 */
import type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
} from "./windows-spawn.js";

import {
  applyWindowsSpawnProgramPolicy as _applyPolicy,
  materializeWindowsSpawnProgram as _materialize,
  resolveWindowsSpawnProgramCandidate as _resolveCandidate,
} from "./windows-spawn.js";

export const resolveWindowsSpawnProgramCandidate: typeof _resolveCandidate =
  typeof _resolveCandidate === "function"
    ? _resolveCandidate
    : (p: { command: string }): WindowsSpawnProgramCandidate => ({
        command: p.command,
        leadingArgv: [],
        resolution: "direct",
      });

export const applyWindowsSpawnProgramPolicy: typeof _applyPolicy =
  typeof _applyPolicy === "function"
    ? _applyPolicy
    : (p) => ({
        command: p.candidate.command,
        leadingArgv: p.candidate.leadingArgv,
        resolution: p.candidate.resolution as WindowsSpawnResolution,
        shell:
          p.candidate.resolution === "unresolved-wrapper" ? true : undefined,
        windowsHide: p.candidate.windowsHide,
      });

export const materializeWindowsSpawnProgram: typeof _materialize =
  typeof _materialize === "function"
    ? _materialize
    : (program, argv) => ({
        command: program.command,
        argv: [...program.leadingArgv, ...argv],
        resolution: program.resolution,
        shell: program.shell,
        windowsHide: program.windowsHide,
      });
