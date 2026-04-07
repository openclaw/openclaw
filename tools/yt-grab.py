#!/usr/bin/env python3
"""
yt-grab: YouTube media downloader for OpenClaw tool integration.

Usage:
    python yt-grab.py <url> [options]

Options:
    -a, --audio-only       Download audio only (MP3)
    -q, --quality QUALITY  Video quality: best|1080p|720p|480p|360p (default: best)
    -f, --format FORMAT    Output format: mp4|webm|mkv|mp3 (default: mp4, or mp3 with --audio-only)
    -o, --output DIR       Output directory (default: ~/Downloads/yt-grab)
    --info                 Print video info (title, duration, formats) without downloading
    --transcript           Extract audio and return path for transcription pipelines

Examples:
    python yt-grab.py "https://youtube.com/watch?v=..." --audio-only
    python yt-grab.py "https://youtube.com/watch?v=..." --info
    python yt-grab.py "https://youtube.com/watch?v=..." --transcript -o C:/tmp/audio
"""

import subprocess
import sys
import os
import json
import argparse
import shutil
from pathlib import Path


def ensure_ytdlp():
    """Ensure yt-dlp is available, install if needed."""
    if shutil.which("yt-dlp"):
        return "yt-dlp"
    # Try pip install
    print("[yt-grab] yt-dlp not found, installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "yt-dlp", "-q"])
    return sys.executable + " -m yt_dlp"


def get_video_info(url: str) -> dict:
    """Fetch video metadata without downloading."""
    cmd = ["yt-dlp", "--dump-json", "--no-download", url]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[yt-grab] Error fetching info: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return json.loads(result.stdout)


def download(url: str, output_dir: str, audio_only: bool = False,
             quality: str = "best", fmt: str = None, transcript_mode: bool = False) -> str:
    """Download media from URL. Returns path to downloaded file."""
    output_dir = Path(output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    output_template = str(output_dir / "%(title)s.%(ext)s")

    cmd = ["yt-dlp"]

    if audio_only or transcript_mode:
        effective_fmt = fmt or "mp3"
        cmd += [
            "-x",
            "--audio-format", effective_fmt if not transcript_mode else "wav",
            "--audio-quality", "0",  # best quality
        ]
        if transcript_mode:
            # For transcription: 16kHz mono WAV is optimal
            cmd += [
                "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
            ]
    else:
        effective_fmt = fmt or "mp4"
        quality_map = {
            "best": "bestvideo+bestaudio/best",
            "1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
            "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
            "480p": "bestvideo[height<=480]+bestaudio/best[height<=480]",
            "360p": "bestvideo[height<=360]+bestaudio/best[height<=360]",
        }
        fmt_str = quality_map.get(quality, quality_map["best"])
        cmd += ["-f", fmt_str]
        if effective_fmt != "mp4":
            cmd += ["--merge-output-format", effective_fmt]

    cmd += [
        "-o", output_template,
        "--no-playlist",
        "--print", "after_move:filepath",
        url,
    ]

    print(f"[yt-grab] Downloading {'audio' if audio_only or transcript_mode else 'video'}...")
    print(f"[yt-grab] Output dir: {output_dir}")

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[yt-grab] Error: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    # The --print flag outputs the final filepath
    filepath = result.stdout.strip().split("\n")[-1]
    print(f"[yt-grab] Complete: {filepath}")
    return filepath


def main():
    parser = argparse.ArgumentParser(description="YouTube media downloader for OpenClaw")
    parser.add_argument("url", help="YouTube URL to download")
    parser.add_argument("-a", "--audio-only", action="store_true",
                        help="Download audio only (MP3)")
    parser.add_argument("-q", "--quality", default="best",
                        choices=["best", "1080p", "720p", "480p", "360p"],
                        help="Video quality (default: best)")
    parser.add_argument("-f", "--format", default=None,
                        help="Output format: mp4, webm, mkv, mp3, wav")
    parser.add_argument("-o", "--output", default="~/Downloads/yt-grab",
                        help="Output directory")
    parser.add_argument("--info", action="store_true",
                        help="Print video info without downloading")
    parser.add_argument("--transcript", action="store_true",
                        help="Download audio optimized for transcription (16kHz mono WAV)")

    args = parser.parse_args()

    ensure_ytdlp()

    if args.info:
        info = get_video_info(args.url)
        print(json.dumps({
            "title": info.get("title"),
            "duration": info.get("duration"),
            "duration_string": info.get("duration_string"),
            "uploader": info.get("uploader"),
            "view_count": info.get("view_count"),
            "description": info.get("description", "")[:500],
            "formats_available": len(info.get("formats", [])),
        }, indent=2))
        return

    filepath = download(
        url=args.url,
        output_dir=args.output,
        audio_only=args.audio_only,
        quality=args.quality,
        fmt=args.format,
        transcript_mode=args.transcript,
    )

    # Output structured result for tool parsing
    print(json.dumps({
        "status": "success",
        "filepath": filepath,
        "mode": "transcript" if args.transcript else ("audio" if args.audio_only else "video"),
    }))


if __name__ == "__main__":
    main()
