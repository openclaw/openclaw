# Video CLI — Implementation Plan

## Goal

Add a direct terminal CLI for video generation (`openclaw video`) that reuses the existing video generation runtime, provider registry, and plugin infrastructure. **Additive only — no deletions or modifications to existing code paths.**

The existing agent tool (`video_generate`) continues to work unchanged. This adds a parallel CLI entry point on top of the same backend.

---

## Proposed CLI Surface

```bash
# Generate a video
openclaw video generate --prompt "a cat walking on the moon" --model google/veo-3

# Generate with options
openclaw video generate \
  --prompt "sunset timelapse" \
  --model runway/gen4.5 \
  --aspect-ratio 16:9 \
  --duration 8 \
  --resolution 1080P \
  --output ./my-video.mp4

# Generate from reference image
openclaw video generate \
  --prompt "animate this photo" \
  --image ./photo.jpg \
  --model openai/sora-2

# List available providers and models
openclaw video list

# Check status of a running generation
openclaw video status --task-id <id>
```

---

## What We Reuse (Existing Code — No Changes)

| Component               | Location                                    | What It Provides                                                 |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Generation runtime      | `src/video-generation/runtime.ts`           | `generateVideo()` with fallover                                  |
| Provider registry       | `src/video-generation/provider-registry.ts` | `listVideoGenerationProviders()`, `getVideoGenerationProvider()` |
| Duration normalization  | `src/video-generation/duration-support.ts`  | Provider-specific duration constraints                           |
| Model ref parsing       | `src/video-generation/model-ref.ts`         | `provider/model` format parsing                                  |
| Types                   | `src/video-generation/types.ts`             | All provider/request/result types                                |
| Media storage           | `src/media/store.ts`                        | `saveMediaBuffer()`                                              |
| FFmpeg                  | `src/media/ffmpeg-exec.ts`                  | Media post-processing                                            |
| Plugin registry         | `src/cli/plugin-registry.ts`                | `ensurePluginRegistryLoaded()`                                   |
| Config resolution       | `src/cli/command-config-resolution.ts`      | Config + secrets loading                                         |
| All 12 provider plugins | `extensions/*/video-generation-provider.ts` | Provider implementations                                         |
| Plugin SDK types        | `src/plugin-sdk/video-generation.ts`        | Shared type exports                                              |

---

## New Files to Add

### 1. CLI Registration — `src/cli/video-cli.ts`

Register `openclaw video` as a subcli with three subcommands: `generate`, `list`, `status`.

**Pattern to follow:** `src/cli/models-cli.ts` (subcli with subcommands)

```
src/cli/video-cli.ts
  └── registerVideoCli(program)
        ├── video.command("generate")  → videoGenerateCommand()
        ├── video.command("list")      → videoListCommand()
        └── video.command("status")    → videoStatusCommand()
```

**Wire into:** `src/cli/program/register.subclis.ts` — add entry for `video-cli`.

### 2. Command Implementations — `src/commands/video-generate.ts`

Core logic for the `generate` subcommand:

```typescript
export async function videoGenerateCommand(opts: VideoGenerateOpts, runtime: Runtime) {
  // 1. Load config + plugin registry
  // 2. Resolve provider/model from --model flag or config fallback
  // 3. Load reference assets from --image/--video paths
  // 4. Call generateVideo() from src/video-generation/runtime.ts
  // 5. Save output via saveMediaBuffer() or write to --output path
  // 6. Print result path / metadata to stdout
}
```

### 3. Command Implementations — `src/commands/video-list.ts`

List available providers, models, and capabilities:

```typescript
export async function videoListCommand(opts: VideoListOpts, runtime: Runtime) {
  // 1. Load plugin registry
  // 2. Call listVideoGenerationProviders()
  // 3. Print table: provider, default model, models[], configured status
  // 4. Support --json flag for machine-readable output
}
```

### 4. Command Implementations — `src/commands/video-status.ts`

Check status of a background generation task:

```typescript
export async function videoStatusCommand(opts: VideoStatusOpts, runtime: Runtime) {
  // 1. Look up task by --task-id
  // 2. Print current state (pending, running, complete, failed)
  // 3. If complete, print output path
}
```

---

## CLI Options

### `openclaw video generate`

| Flag             | Type     | Required | Description                                   |
| ---------------- | -------- | -------- | --------------------------------------------- |
| `--prompt`       | string   | yes      | Text description of video to generate         |
| `--model`        | string   | no       | Provider/model override (e.g. `google/veo-3`) |
| `--image`        | string[] | no       | Reference image path(s), max 5                |
| `--video`        | string[] | no       | Reference video path(s), max 4                |
| `--aspect-ratio` | string   | no       | e.g. `16:9`, `9:16`, `1:1`                    |
| `--resolution`   | string   | no       | `480P`, `720P`, `1080P`                       |
| `--duration`     | number   | no       | Duration in seconds                           |
| `--audio`        | boolean  | no       | Enable audio generation                       |
| `--output`       | string   | no       | Output file path (default: auto-named in cwd) |
| `--json`         | boolean  | no       | Output result as JSON                         |

### `openclaw video list`

| Flag     | Type    | Description |
| -------- | ------- | ----------- |
| `--json` | boolean | JSON output |

### `openclaw video status`

| Flag        | Type    | Description      |
| ----------- | ------- | ---------------- |
| `--task-id` | string  | Task ID to check |
| `--json`    | boolean | JSON output      |

---

## Execution Flow (CLI Path)

```
openclaw video generate --prompt "..." --model google/veo-3
    │
    ├── registerVideoCli()                          [NEW - src/cli/video-cli.ts]
    │       registers Commander subcommands
    │
    ├── videoGenerateCommand()                      [NEW - src/commands/video-generate.ts]
    │       ├── ensurePluginRegistryLoaded()         [EXISTING]
    │       ├── loadConfig() + resolveSecrets()      [EXISTING]
    │       ├── parseModelRef(opts.model)             [EXISTING - model-ref.ts]
    │       ├── loadReferenceAssets(opts.image/video) [EXISTING - video-generate-tool.ts]
    │       ├── generateVideo({                       [EXISTING - runtime.ts]
    │       │     prompt, model, images, videos,
    │       │     aspectRatio, resolution, duration
    │       │   })
    │       ├── saveMediaBuffer() or fs.writeFile()   [EXISTING / standard]
    │       └── print result to stdout
    │
    └── exit
```

---

## Integration Points

### Registering the Subcli

In `src/cli/program/register.subclis.ts`, add:

```typescript
{ name: "video", loader: () => import("../video-cli.js") }
```

This follows the lazy-load pattern — the video CLI module only loads when `openclaw video` is invoked.

### Progress Output

Use `src/cli/progress.ts` (osc-progress + @clack/prompts spinner) for generation progress in the terminal. The existing polling pattern from provider implementations can drive spinner updates.

### Output Handling

- **Default:** save to current directory with auto-generated name (`video-1.mp4`)
- **`--output`:** save to specified path
- **`--json`:** print `{ provider, model, path, duration, size }` to stdout

---

## What Stays Unchanged

- Agent tool `video_generate` — untouched, still works through agent chat
- All provider plugins — no changes needed
- Video generation runtime — called by CLI the same way the agent tool calls it
- Task management — CLI can optionally create tasks or run synchronously
- Config structure — same `agents.defaults.videoGenerationModel` config applies

---

## Summary

|                    | Agent Tool (existing)  | CLI (new)                     |
| ------------------ | ---------------------- | ----------------------------- |
| Entry point        | Agent chat → tool call | `openclaw video generate`     |
| Execution          | Async background task  | Synchronous (wait for result) |
| Output             | MEDIA: path in chat    | File on disk + stdout         |
| Progress           | Task status polling    | Terminal spinner              |
| Provider selection | Same logic             | Same logic                    |
| Generation runtime | `generateVideo()`      | `generateVideo()`             |
| Config             | Same config            | Same config                   |
