import fs from "node:fs/promises";
import path from "node:path";

/** Synthetic Whisper writes the same transcript-file contract as the real CLI. */
export async function createWhisperExecutable(dir: string, transcript = "mocked-local-whisper") {
  const executablePath = path.join(dir, "whisper");
  const quotedTranscript = "'" + transcript.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(
    executablePath,
    [
      "#!/bin/sh",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output_dir) output_dir="$2"; shift 2 ;;',
      '    *) audio_path="$1"; shift ;;',
      "  esac",
      "done",
      'audio_name="${audio_path##*/}"',
      `printf "%s\\n" ${quotedTranscript} > "$output_dir/\${audio_name%.*}.txt"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executablePath;
}
