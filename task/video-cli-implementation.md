# Video CLI — Implementation Guide

## Overview

Add `openclaw video` CLI commands (`generate`, `list`, `status`) that reuse the existing video generation runtime. Additive only — no existing code is deleted or modified.

**Estimated time:** >20 minutes — broken into subtasks below.

---

## Subtask 1: CLI Registration (`src/cli/video-cli.ts`)

### What

Create the Commander.js subcli that registers `openclaw video` with three subcommands.

### Files to Create

- **`src/cli/video-cli.ts`** — subcli registration (follow pattern from `src/cli/models-cli.ts`)

### Files to Modify

- **`src/cli/program/register.subclis.ts`** — add lazy-load entry to the `entries` array:
  ```typescript
  {
    name: "video",
    description: "Video generation commands",
    hasSubcommands: true,
    register: async (program) => {
      const mod = await import("../video-cli.js");
      mod.registerVideoCli(program);
    },
  }
  ```

### Reference Files

- `src/cli/models-cli.ts` — subcli pattern to follow (nested `.command()` chaining, `runCommandWithRuntime()` wrapper)
- `src/cli/program/register.subclis.ts` — `SubCliEntry` type shape (`name`, `description`, `hasSubcommands`, `register`)
- `src/cli/progress.ts` — `withProgress()` for spinner during generation

### Implementation Details

```typescript
// src/cli/video-cli.ts
import { Command } from "commander";

export function registerVideoCli(program: Command) {
  const video = program.command("video").description("Video generation commands");

  video
    .command("generate")
    .description("Generate a video from a text prompt")
    .requiredOption("--prompt <text>", "Text description of video to generate")
    .option("--model <provider/model>", "Provider and model override")
    .option("--image <path...>", "Reference image path(s), max 5")
    .option("--video <path...>", "Reference video path(s), max 4")
    .option("--aspect-ratio <ratio>", "Aspect ratio (e.g. 16:9)")
    .option("--resolution <res>", "Resolution: 480P, 720P, 1080P")
    .option("--duration <seconds>", "Duration in seconds", parseFloat)
    .option("--audio", "Enable audio generation")
    .option("--output <path>", "Output file path")
    .option("--json", "Output result as JSON")
    .action(async (opts) => {
      // lazy import + runCommandWithRuntime pattern
    });

  video
    .command("list")
    .description("List available video generation providers and models")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      /* ... */
    });

  video
    .command("status")
    .description("Check status of a video generation task")
    .requiredOption("--task-id <id>", "Task ID to check")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      /* ... */
    });
}
```

### Test File

- **`src/cli/video-cli.test.ts`** — test that subcommands register correctly and pass options through

```typescript
// Test pattern from src/cli/models-cli.test.ts and src/cli/completion-cli.test.ts
import { Command } from "commander";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { registerVideoCli } from "./video-cli.js";

// Mock command implementations
const mocks = vi.hoisted(() => ({
  videoGenerateCommand: vi.fn().mockResolvedValue(undefined),
  videoListCommand: vi.fn().mockResolvedValue(undefined),
  videoStatusCommand: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands/video-generate.js", () => ({
  videoGenerateCommand: mocks.videoGenerateCommand,
}));
vi.mock("../commands/video-list.js", () => ({
  videoListCommand: mocks.videoListCommand,
}));
vi.mock("../commands/video-status.js", () => ({
  videoStatusCommand: mocks.videoStatusCommand,
}));

describe("video cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createProgram() {
    const program = new Command();
    registerVideoCli(program);
    return program;
  }

  it("registers video command with subcommands", () => {
    const program = createProgram();
    const video = program.commands.find((c) => c.name() === "video");
    expect(video).toBeDefined();
    const subNames = video!.commands.map((c) => c.name());
    expect(subNames).toContain("generate");
    expect(subNames).toContain("list");
    expect(subNames).toContain("status");
  });

  it("passes generate options correctly", async () => {
    // use runRegisteredCli or parseAsync with argv
  });
});
```

### Long-Term Considerations

- Lazy loading ensures `openclaw video` only loads video modules when invoked — no startup penalty for other commands
- Following the subcli pattern means future subcommands (e.g. `openclaw video edit`, `openclaw video upscale`) slot in naturally
- Commander.js option parsing is shared infra — no custom arg parsing to maintain

---

## Subtask 2: Generate Command (`src/commands/video-generate.ts`)

### What

Implement the core `openclaw video generate` logic: validate inputs, resolve provider, call `generateVideo()`, save output.

### Files to Create

- **`src/commands/video-generate.ts`** — command implementation

### Reference Files (Reused, Not Modified)

- `src/video-generation/runtime.ts` — `generateVideo(params: GenerateVideoParams): Promise<GenerateVideoRuntimeResult>`
- `src/video-generation/types.ts` — `VideoGenerationSourceAsset`, `VideoGenerationResolution`, `GeneratedVideoAsset`
- `src/video-generation/model-ref.ts` — model string parsing (`provider/model` format)
- `src/cli/plugin-registry.ts` — `ensurePluginRegistryLoaded()`
- `src/cli/command-config-resolution.ts` — config + secrets loading
- `src/cli/progress.ts` — `withProgress()` for terminal spinner
- `src/media/store.ts` — `saveMediaBuffer()` for managed storage
- `src/runtime.ts` — `defaultRuntime` for log/error/exit
- `src/terminal/table.ts` — ANSI-safe table output (for result summary)

### Implementation Details

```typescript
// src/commands/video-generate.ts
import type { Runtime } from "../runtime.js";

export type VideoGenerateOpts = {
  prompt: string;
  model?: string;
  image?: string[];
  video?: string[];
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  audio?: boolean;
  output?: string;
  json?: boolean;
};

export async function videoGenerateCommand(opts: VideoGenerateOpts, runtime: Runtime) {
  // 1. ensurePluginRegistryLoaded()
  // 2. loadConfig() + resolveCommandConfigWithSecrets()
  // 3. Validate inputs (image count <= 5, video count <= 4, aspect ratio format)
  // 4. Load reference assets from local paths into VideoGenerationSourceAsset[]
  //    - Read file into Buffer, detect mimeType
  //    - NOTE: loadReferenceAssets() in video-generate-tool.ts is NOT exported
  //    - Write a thin local loader or extract shared helper (see Long-Term below)
  // 5. withProgress() spinner wrapping generateVideo() call
  // 6. On success: write video buffer to --output path or auto-named file in cwd
  // 7. Print summary (provider, model, path, duration, size) or --json output
  // 8. On failure: print error details including all fallback attempts
}
```

### Key Design Decision: Asset Loading

`loadReferenceAssets()` in `src/agents/tools/video-generate-tool.ts:325` is **not exported** — it's an internal function with sandbox-aware logic the CLI doesn't need. Options:

1. **Write a thin CLI-specific loader** in `src/commands/video-generate.ts` that reads local files into `{ buffer, mimeType }` — simpler, no sandbox complexity
2. **Later refactor:** if both paths diverge, extract shared asset loading to `src/video-generation/asset-loader.ts`

Recommend option 1 for now (additive, no changes to existing code).

### Test File

- **`src/commands/video-generate.test.ts`**

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { videoGenerateCommand } from "./video-generate.js";

// Mock the video generation runtime
const mocks = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  ensurePluginRegistryLoaded: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock("../video-generation/runtime.js", () => ({
  generateVideo: mocks.generateVideo,
}));

describe("videoGenerateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls generateVideo with prompt and model", async () => {
    mocks.generateVideo.mockResolvedValue({
      videos: [{ buffer: Buffer.from("fake"), mimeType: "video/mp4" }],
      provider: "google",
      model: "veo-3",
      attempts: [],
      ignoredOverrides: [],
    });

    await videoGenerateCommand({ prompt: "a sunset", model: "google/veo-3" }, mockRuntime);

    expect(mocks.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a sunset", modelOverride: "google/veo-3" }),
    );
  });

  it("validates image count <= 5", async () => {
    // pass 6 images, expect error
  });

  it("validates video count <= 4", async () => {
    // pass 5 videos, expect error
  });

  it("writes output to --output path", async () => {
    // mock fs.writeFile, verify path
  });

  it("prints JSON when --json flag set", async () => {
    // verify runtime.writeJson called
  });

  it("reports all fallback attempts on failure", async () => {
    // mock generateVideo throwing with attempts array
  });
});
```

### Long-Term Considerations

- If asset loading diverges between agent tool and CLI, extract to `src/video-generation/asset-loader.ts` as a shared module
- `generateVideo()` already handles fallover — CLI gets that for free
- Progress spinner can later show provider-specific status if providers expose progress callbacks
- `--output` with directory path (e.g. `--output ./videos/`) could auto-name within that dir in a future iteration

---

## Subtask 3: List Command (`src/commands/video-list.ts`)

### What

Implement `openclaw video list` — show available providers, their models, capabilities, and configuration status.

### Files to Create

- **`src/commands/video-list.ts`** — command implementation

### Reference Files (Reused, Not Modified)

- `src/video-generation/provider-registry.ts` — `listVideoGenerationProviders(cfg): VideoGenerationProviderPlugin[]`
- `src/video-generation/types.ts` — `VideoGenerationProvider`, `VideoGenerationProviderCapabilities`
- `src/cli/plugin-registry.ts` — `ensurePluginRegistryLoaded()`
- `src/terminal/table.ts` — table rendering
- `src/runtime.ts` — `defaultRuntime`

### Implementation Details

```typescript
// src/commands/video-list.ts
export type VideoListOpts = {
  json?: boolean;
};

export async function videoListCommand(opts: VideoListOpts, runtime: Runtime) {
  // 1. ensurePluginRegistryLoaded()
  // 2. listVideoGenerationProviders(cfg)
  // 3. For each provider: id, label, defaultModel, models[], configured status, capabilities
  // 4. --json: runtime.writeJson(providers)
  // 5. default: render table via src/terminal/table.ts
}
```

**Example output:**

```
Provider      Default Model                    Models  Configured  Audio  Max Duration
────────────  ───────────────────────────────  ──────  ──────────  ─────  ────────────
google        veo-3.1-fast-generate-preview    2       ✓           ✓      8s
openai        sora-2                           1       ✓           ✗      12s
runway        gen4.5                           3       ✗           ✗      10s
...
```

### Test File

- **`src/commands/video-list.test.ts`**

```typescript
describe("videoListCommand", () => {
  it("lists all registered providers", async () => {
    /* ... */
  });
  it("shows configured status per provider", async () => {
    /* ... */
  });
  it("outputs JSON when --json flag set", async () => {
    /* ... */
  });
  it("handles no providers gracefully", async () => {
    /* ... */
  });
});
```

### Long-Term Considerations

- Table output follows `src/terminal/table.ts` patterns — consistent with `openclaw status`, `openclaw models list`
- Provider capabilities display scales as new capability flags are added to `VideoGenerationProviderCapabilities`
- JSON output enables scripting and piping (e.g. `openclaw video list --json | jq '.[] | select(.configured)'`)

---

## Subtask 4: Status Command (`src/commands/video-status.ts`)

### What

Implement `openclaw video status` — check the state of a background video generation task.

### Files to Create

- **`src/commands/video-status.ts`** — command implementation

### Reference Files (Reused, Not Modified)

- `src/agents/video-generation-task-status.ts` — `buildVideoGenerationTaskStatusDetails(task)`, `buildVideoGenerationTaskStatusText(task)`
- `src/agents/tools/video-generate-background.ts` — task record creation/completion types
- `src/runtime.ts` — `defaultRuntime`

### Implementation Details

```typescript
// src/commands/video-status.ts
export type VideoStatusOpts = {
  taskId: string;
  json?: boolean;
};

export async function videoStatusCommand(opts: VideoStatusOpts, runtime: Runtime) {
  // 1. Look up task record by opts.taskId
  // 2. Use buildVideoGenerationTaskStatusDetails(task) for structured data
  // 3. --json: runtime.writeJson(details)
  // 4. default: use buildVideoGenerationTaskStatusText(task) for human-readable output
  // 5. If task not found: print error and exit 1
}
```

### Test File

- **`src/commands/video-status.test.ts`**

```typescript
describe("videoStatusCommand", () => {
  it("shows status for active task", async () => {
    /* ... */
  });
  it("shows completed task with output path", async () => {
    /* ... */
  });
  it("shows failed task with error details", async () => {
    /* ... */
  });
  it("exits 1 when task not found", async () => {
    /* ... */
  });
  it("outputs JSON when --json flag set", async () => {
    /* ... */
  });
});
```

### Long-Term Considerations

- Task status reuses the existing task system — no parallel tracking to maintain
- Status command could later support `--watch` flag for live polling (spinner + periodic refresh)
- Task IDs are stable across sessions — users can check status from a different terminal

---

## Subtask 5: Integration Tests

### What

End-to-end tests that verify the full CLI path: arg parsing → command execution → output.

### Files to Create

- **`src/cli/video-cli.integration.test.ts`** — integration tests for the full CLI flow

### Reference Files

- `src/cli/models-cli.test.ts` — integration test pattern using `runRegisteredCli()`
- Test utilities at `src/test-utils/command-runner.ts` (if available) or direct Commander `parseAsync`

### Test Cases

```typescript
describe("video cli integration", () => {
  describe("generate", () => {
    it("runs generate with minimal args (--prompt only)", async () => {
      // mock generateVideo, verify called with prompt, default model from config
    });

    it("passes all options through to generateVideo", async () => {
      // --prompt, --model, --aspect-ratio, --resolution, --duration, --audio
    });

    it("writes video to --output path", async () => {
      // verify fs.writeFile called with correct path
    });

    it("auto-names output file when no --output given", async () => {
      // verify default naming pattern (video-1.mp4)
    });

    it("prints JSON result with --json", async () => {
      // verify JSON structure: { provider, model, path, duration, size }
    });

    it("reports error with fallback attempt details", async () => {
      // mock generateVideo failure, verify error output includes attempts
    });
  });

  describe("list", () => {
    it("renders provider table", async () => {
      /* ... */
    });
    it("renders JSON with --json", async () => {
      /* ... */
    });
  });

  describe("status", () => {
    it("shows task status by id", async () => {
      /* ... */
    });
    it("exits 1 for unknown task id", async () => {
      /* ... */
    });
  });
});
```

### Long-Term Considerations

- Integration tests catch wiring bugs between CLI registration and command implementations
- Mocking at the `generateVideo()` boundary keeps tests fast while covering the full CLI path
- JSON output tests serve as a contract for scripting consumers

---

## File Summary

### New Files (7)

| File                                  | Purpose                                |
| ------------------------------------- | -------------------------------------- |
| `src/cli/video-cli.ts`                | CLI subcli registration (Commander.js) |
| `src/commands/video-generate.ts`      | Generate command implementation        |
| `src/commands/video-list.ts`          | List command implementation            |
| `src/commands/video-status.ts`        | Status command implementation          |
| `src/cli/video-cli.test.ts`           | Unit tests for CLI registration        |
| `src/commands/video-generate.test.ts` | Unit tests for generate command        |
| `src/commands/video-list.test.ts`     | Unit tests for list command            |
| `src/commands/video-status.test.ts`   | Unit tests for status command          |

### Modified Files (1)

| File                                  | Change                            |
| ------------------------------------- | --------------------------------- |
| `src/cli/program/register.subclis.ts` | Add `video` entry to subcli array |

### Existing Files Reused (Not Modified)

| File                                         | What's Reused                                              |
| -------------------------------------------- | ---------------------------------------------------------- |
| `src/video-generation/runtime.ts`            | `generateVideo()`, `listRuntimeVideoGenerationProviders()` |
| `src/video-generation/provider-registry.ts`  | `listVideoGenerationProviders()`                           |
| `src/video-generation/types.ts`              | All request/result/provider types                          |
| `src/video-generation/model-ref.ts`          | Model string parsing                                       |
| `src/video-generation/duration-support.ts`   | Duration normalization                                     |
| `src/cli/plugin-registry.ts`                 | `ensurePluginRegistryLoaded()`                             |
| `src/cli/command-config-resolution.ts`       | Config + secrets resolution                                |
| `src/cli/progress.ts`                        | `withProgress()` spinner                                   |
| `src/media/store.ts`                         | `saveMediaBuffer()`                                        |
| `src/terminal/table.ts`                      | Table rendering                                            |
| `src/runtime.ts`                             | `defaultRuntime`                                           |
| `src/agents/video-generation-task-status.ts` | Task status helpers                                        |
| `extensions/*/video-generation-provider.ts`  | All 12 provider plugins                                    |

---

## Dependency Graph

```
src/cli/program/register.subclis.ts
    │
    └── src/cli/video-cli.ts  [NEW]
            │
            ├── src/commands/video-generate.ts  [NEW]
            │       ├── src/video-generation/runtime.ts  (generateVideo)
            │       ├── src/video-generation/types.ts  (types)
            │       ├── src/cli/plugin-registry.ts  (ensurePluginRegistryLoaded)
            │       ├── src/cli/progress.ts  (withProgress)
            │       └── src/media/store.ts  (saveMediaBuffer)
            │
            ├── src/commands/video-list.ts  [NEW]
            │       ├── src/video-generation/provider-registry.ts  (listVideoGenerationProviders)
            │       └── src/terminal/table.ts  (table rendering)
            │
            └── src/commands/video-status.ts  [NEW]
                    └── src/agents/video-generation-task-status.ts  (task helpers)
```

---

## Implementation Order

1. **Subtask 1** — CLI registration (`video-cli.ts` + `register.subclis.ts` entry)
2. **Subtask 3** — List command (simplest, validates provider registry wiring)
3. **Subtask 2** — Generate command (core feature, depends on wiring from subtask 1)
4. **Subtask 4** — Status command (depends on task system understanding)
5. **Subtask 5** — Integration tests (validates full path end-to-end)

This order lets you verify the CLI wiring early with the simpler `list` command before tackling generation.

---

## Implementation Results

**Status:** Complete. All files implemented and tests passing.

### Test Results

```
pnpm test src/cli/video-cli.test.ts src/commands/video-list.test.ts src/commands/video-generate.test.ts src/commands/video-status.test.ts

Test Files  4 passed (4)
     Tests  21 passed (21)
  Duration  206ms
```

### TypeScript Check

Zero type errors in video CLI files (`pnpm tsgo` — pre-existing errors in unrelated files only).

### Formatting

All files pass `pnpm format` (oxfmt).

### Files Created

| File                                  | Lines | Purpose                                                        |
| ------------------------------------- | ----- | -------------------------------------------------------------- |
| `src/cli/video-cli.ts`                | 77    | Commander.js subcli with generate/list/status subcommands      |
| `src/commands/video-generate.ts`      | 133   | Generate command: validate, call generateVideo(), save to disk |
| `src/commands/video-list.ts`          | 83    | List command: table + JSON output of providers/capabilities    |
| `src/commands/video-status.ts`        | 38    | Status command: task lookup by ID                              |
| `src/cli/video-cli.test.ts`           | 98    | 4 tests: registration + option passthrough for all subcommands |
| `src/commands/video-generate.test.ts` | 168   | 8 tests: generation, validation, output, JSON, warnings        |
| `src/commands/video-list.test.ts`     | 114   | 4 tests: table, JSON, empty, alphabetical sort                 |
| `src/commands/video-status.test.ts`   | 106   | 5 tests: found, JSON, not-found, wrong-kind                    |

### Files Modified

| File                                    | Change                        |
| --------------------------------------- | ----------------------------- |
| `src/cli/program/register.subclis.ts`   | Added `video` lazy-load entry |
| `src/cli/program/subcli-descriptors.ts` | Added `video` descriptor      |

### Backward Compatibility

- No existing files deleted or modified (beyond the two registration files)
- Agent tool `video_generate` unchanged
- All 12 provider plugins unchanged
- Config structure unchanged
