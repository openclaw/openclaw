# Current Video Generation Implementation

## Overview

Video generation is an agent tool (`video_generate`) that lets users create videos from text prompts and optional reference media (images/videos). It runs asynchronously in the background, supports 12 providers with automatic fallover, and delivers results back to the originating chat session.

---

## Directory Structure

```
src/video-generation/
  runtime.ts                  # Core async generation pipeline with fallover
  types.ts                    # Type definitions (providers, requests, results)
  provider-registry.ts        # Dynamic provider discovery and registration
  duration-support.ts         # Duration normalization per provider constraints
  model-ref.ts                # Model reference parsing (provider/model format)

src/agents/tools/
  video-generate-tool.ts      # Main tool implementation (~900 LOC)
  video-generate-background.ts # Async task management (create, progress, complete)
  video-generate-tool.actions.ts # Tool actions (list, status, generate)

src/agents/
  video-generation-task-status.ts # Task tracking and status queries

src/media/
  ffmpeg-exec.ts              # FFmpeg wrapper for media processing
  ffmpeg-limits.ts            # FFmpeg timeout/buffer settings

src/plugin-sdk/
  video-generation.ts         # Public SDK exports for provider plugins

extensions/                   # Bundled provider plugins (12 total)
```

---

## Supported Providers (12)

| Provider      | Default Model                 | API Key Env Var       |
| ------------- | ----------------------------- | --------------------- |
| Alibaba       | wan2.6-t2v                    | `MODELSTUDIO_API_KEY` |
| BytePlus      | seedance-1-0-lite-t2v-250428  | `BYTEPLUS_API_KEY`    |
| ComfyUI       | workflow                      | `COMFY_API_KEY`       |
| fal           | fal-ai/minimax/video-01-live  | `FAL_KEY`             |
| Google (Veo)  | veo-3.1-fast-generate-preview | `GEMINI_API_KEY`      |
| MiniMax       | MiniMax-Hailuo-2.3            | `MINIMAX_API_KEY`     |
| OpenAI (Sora) | sora-2                        | `OPENAI_API_KEY`      |
| Qwen          | wan2.6-t2v                    | `QWEN_API_KEY`        |
| Runway        | gen4.5                        | `RUNWAYML_API_SECRET` |
| Together AI   | Wan-AI/Wan2.2-T2V-A14B        | `TOGETHER_API_KEY`    |
| Vydra         | veo3                          | `VYDRA_API_KEY`       |
| xAI (Grok)    | grok-imagine-video            | `XAI_API_KEY`         |

Each provider is a bundled plugin under `extensions/` with its own `video-generation-provider.ts` and manifest (`openclaw.plugin.json`).

---

## Tool Interface

### Actions

| Action     | Description                                          |
| ---------- | ---------------------------------------------------- |
| `generate` | (default) Create video from prompt + optional inputs |
| `status`   | Check in-flight task state                           |
| `list`     | Show available providers, models, and capabilities   |

### Parameters

| Category | Parameters                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------- |
| Required | `prompt` — text description of video to generate                                               |
| Inputs   | `image`, `images` (max 5), `video`, `videos` (max 4)                                           |
| Style    | `aspectRatio`, `resolution` (480P/720P/1080P), `durationSeconds`, `size`, `audio`, `watermark` |
| Advanced | `model` (override), `filename`, `action`                                                       |

### Supported Aspect Ratios

`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`

---

## Execution Flow

```
1. User asks agent to generate video
       |
2. Agent calls video_generate tool (prompt, optional references)
       |
3. Tool validates inputs (aspect ratio, input counts, etc.)
       |
4. Provider selection:
       config primary -> config fallbacks -> auto-detect (first with valid auth)
       |
5. Creates task record, schedules background job, returns immediately
       |
6. Background job: loads assets, calls provider.generateVideo()
       |
7. Provider makes API request, polls for completion
       |
8. Video downloaded, saved to managed media directory
       |
9. Task marked complete, session woken with completion event
       |
10. Agent posts MEDIA:path to chat -> user receives video
```

---

## Provider Selection Logic

Resolution order:

1. **User override** — `model` parameter on tool call (`provider/model` format)
2. **Config primary** — `agents.defaults.videoGenerationModel.primary`
3. **Config fallbacks** — `agents.defaults.videoGenerationModel.fallbacks` (in order)
4. **Auto-detect** — first provider with valid auth, then alphabetical

On failure, the system tries the next fallback candidate and collects a detailed attempt log.

---

## Configuration

```bash
# Set primary provider/model
openclaw config set agents.defaults.videoGenerationModel.primary "google/veo-3.1-fast-generate-preview"
```

```json5
{
  agents: {
    defaults: {
      videoGenerationModel: {
        primary: "google/veo-3.1-fast-generate-preview",
        fallbacks: ["runway/gen4.5", "qwen/wan2.6-t2v"],
      },
    },
  },
}
```

Config types defined in `src/config/types.agent-defaults.ts`.

---

## Asset Loading

Reference images/videos can be loaded from:

- Local file paths (with `~` expansion)
- `file://` URLs
- `http(s)://` URLs (remote fetch)
- `data:` URLs (base64-encoded, images only)
- Sandboxed paths (when in sandbox context)

Max file size enforced per provider.

---

## Background Task Management

- Task records linked to `sessionKey` (ties to originating conversation)
- Duplicate guard: if a generation is already active for the session, returns status instead of starting a new one
- Completion events wake the session so the agent can deliver the video

### Key Functions

| Function                              | Location                                        | Purpose                         |
| ------------------------------------- | ----------------------------------------------- | ------------------------------- |
| `createVideoGenerateTool()`           | `src/agents/tools/video-generate-tool.ts`       | Tool definition and execute fn  |
| `generateVideo()`                     | `src/video-generation/runtime.ts`               | Core generation with fallover   |
| `listVideoGenerationProviders()`      | `src/video-generation/provider-registry.ts`     | Discover available providers    |
| `createVideoGenerationTaskRun()`      | `src/agents/tools/video-generate-background.ts` | Create background task record   |
| `completeVideoGenerationTaskRun()`    | `src/agents/tools/video-generate-background.ts` | Mark task complete with results |
| `wakeVideoGenerationTaskCompletion()` | `src/agents/tools/video-generate-background.ts` | Notify session of completion    |

---

## Core Types

```typescript
type VideoGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: VideoGenerationProviderCapabilities;
  isConfigured?: (ctx) => boolean;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

type VideoGenerationProviderCapabilities = {
  maxVideos?: number;
  maxInputImages?: number;
  maxInputVideos?: number;
  maxDurationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  supportedDurationSecondsByModel?: Record<string, readonly number[]>;
  supportsSize?: boolean;
  supportsAspectRatio?: boolean;
  supportsResolution?: boolean;
  supportsAudio?: boolean;
  supportsWatermark?: boolean;
};

type GeneratedVideoAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  metadata?: Record<string, unknown>;
};
```

---

## Plugin Integration

Providers register via plugin manifest:

```json
{
  "contracts": {
    "videoGenerationProviders": ["openai"]
  }
}
```

Discovery flow:

1. Plugin declares `videoGenerationProviders` in manifest
2. Core discovers via `resolvePluginCapabilityProviders()`
3. Providers cached in `buildProviderMaps()` (canonical + aliases)
4. Available at runtime for selection

Providers import types from `openclaw/plugin-sdk/video-generation`.

---

## FFmpeg Integration

Used for local media processing (primarily ComfyUI provider):

- `runFfmpeg(args, options)` — execute ffmpeg command
- `runFfprobe(args, options)` — probe media metadata
- Timeout and buffer limits enforced via `ffmpeg-limits.ts`

---

## Media Storage

- Output saved via `saveMediaBuffer()` from `src/media/store.ts`
- Stored in OpenClaw-managed media directory
- Tool result includes `MEDIA:` paths for chat delivery
- Filename: user-provided hint or default (`video-1.mp4`, etc.)

---

## Documentation

- User-facing docs: `docs/tools/video-generation.md`
