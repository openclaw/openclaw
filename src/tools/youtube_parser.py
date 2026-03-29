"""YouTube video analyzer — extracts transcript and metadata via yt-dlp.

Provides analyze_youtube_video() that fetches subtitles/auto-captions and
video metadata (title, description, duration) without downloading the video.
The extracted text is suitable for passing to the Researcher role for analysis.

Falls back to metadata-only mode if subtitles are unavailable.

v14.4: Uses native yt_dlp Python API instead of CLI subprocess to avoid
venv-path mismatches (P0-2 hotfix).
"""

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger(__name__)

# YouTube URL patterns
_RE_YOUTUBE_URL = re.compile(
    r"(?:https?://)?(?:www\.)?(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)"
    r"([\w-]{11})",
)


@dataclass
class YouTubeResult:
    """Result of YouTube video analysis."""
    video_id: str
    title: str = ""
    description: str = ""
    duration_sec: int = 0
    channel: str = ""
    upload_date: str = ""
    transcript: str = ""
    language: str = ""
    success: bool = False
    error: str = ""

    def to_context(self, max_transcript_chars: int = 8000) -> str:
        """Format as context block for LLM consumption."""
        parts = [f"[YOUTUBE VIDEO ANALYSIS]"]
        parts.append(f"Title: {self.title}")
        if self.channel:
            parts.append(f"Channel: {self.channel}")
        if self.upload_date:
            parts.append(f"Upload date: {self.upload_date}")
        if self.duration_sec:
            mins = self.duration_sec // 60
            secs = self.duration_sec % 60
            parts.append(f"Duration: {mins}m {secs}s")
        if self.description:
            desc = self.description[:500]
            parts.append(f"Description: {desc}")
        if self.transcript:
            t = self.transcript[:max_transcript_chars]
            if len(self.transcript) > max_transcript_chars:
                t += "\n[... транскрипт обрезан ...]"
            parts.append(f"\nTranscript ({self.language}):\n{t}")
        elif not self.error:
            parts.append("\n(Субтитры недоступны для этого видео)")
        if self.error:
            parts.append(f"\nError: {self.error}")
        return "\n".join(parts)


def extract_video_id(text: str) -> Optional[str]:
    """Extract YouTube video ID from a URL or text containing a URL."""
    m = _RE_YOUTUBE_URL.search(text)
    return m.group(1) if m else None


def is_youtube_url(text: str) -> bool:
    """Check if text contains a YouTube URL."""
    return bool(_RE_YOUTUBE_URL.search(text))


async def analyze_youtube_video(
    url_or_id: str,
    prefer_lang: str = "ru",
    timeout_sec: int = 30,
) -> YouTubeResult:
    """Fetch transcript and metadata for a YouTube video.

    v14.4: Uses native yt_dlp Python API — no subprocess/CLI, bypasses
    OS PATH issues in venvs. Does NOT download the video.
    """
    video_id = extract_video_id(url_or_id) or url_or_id.strip()
    if not re.match(r"^[\w-]{11}$", video_id):
        return YouTubeResult(
            video_id=video_id, success=False,
            error=f"Invalid video ID: {video_id}",
        )

    url = f"https://www.youtube.com/watch?v={video_id}"
    result = YouTubeResult(video_id=video_id)

    try:
        import yt_dlp
    except ImportError:
        result.error = "yt-dlp not installed. Install with: pip install yt-dlp"
        return result

    # yt_dlp is synchronous — offload to thread to avoid blocking the event loop
    def _extract() -> dict:
        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": [prefer_lang, "en"],
            "subtitlesformat": "vtt",
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=False)

    try:
        info = await asyncio.wait_for(
            asyncio.to_thread(_extract),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        result.error = "yt-dlp extraction timed out"
        return result
    except Exception as e:
        result.error = f"yt-dlp extraction error: {e}"
        return result

    # Step 1: Metadata
    result.title = info.get("title", "")
    result.description = (info.get("description", "") or "")[:1000]
    result.duration_sec = info.get("duration", 0) or 0
    result.channel = info.get("channel", "") or info.get("uploader", "")
    result.upload_date = info.get("upload_date", "")

    # Step 2: Extract subtitles from the info dict
    transcript_text = _extract_subtitles_from_info(info, prefer_lang)
    if transcript_text:
        result.transcript = transcript_text
        result.language = prefer_lang
        result.success = True
    else:
        result.success = bool(result.title)
        if not result.transcript:
            logger.info("No subtitles available", video_id=video_id)

    return result


def _extract_subtitles_from_info(info: dict, prefer_lang: str) -> str:
    """Extract subtitle text from yt-dlp info dict (manual > auto-generated)."""
    for subs_key in ("subtitles", "automatic_captions"):
        subs = info.get(subs_key) or {}
        for lang in (prefer_lang, "en"):
            formats = subs.get(lang, [])
            for fmt in formats:
                # yt_dlp may embed subtitle data directly or provide URLs
                data = fmt.get("data")
                if data:
                    return _clean_subtitle_text(data)
                sub_url = fmt.get("url")
                if sub_url:
                    # Fetch subtitle content from URL (synchronous-safe: called from async context above)
                    try:
                        import urllib.request
                        with urllib.request.urlopen(sub_url, timeout=10) as resp:
                            raw = resp.read().decode("utf-8", errors="replace")
                        return _clean_subtitle_text(raw)
                    except Exception:
                        continue
    return ""


def _clean_subtitle_text(raw: str) -> str:
    """Strip VTT/SRT timestamps and tags from subtitle text."""
    lines = raw.split("\n")
    text_lines: list[str] = []
    seen: set[str] = set()
    for line in lines:
        line = line.strip()
        if not line or line.startswith("WEBVTT") or line.startswith("NOTE"):
            continue
        if re.match(r"^\d{2}:\d{2}", line):
            continue
        if re.match(r"^\d+$", line):
            continue
        line = re.sub(r"<[^>]+>", "", line).strip()
        if line and line not in seen:
            seen.add(line)
            text_lines.append(line)
    return " ".join(text_lines)
