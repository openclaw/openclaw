"""Text-to-Speech Engine — multi-provider TTS with fallback chain.

Supports OpenAI TTS, ElevenLabs, and edge-tts (free offline fallback).
Returns audio bytes (MP3) that can be sent via Telegram voice message
or Discord audio.

Usage:
    engine = TTSEngine(config)
    audio_bytes = await engine.synthesize("Привет, мир!")
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import structlog

logger = structlog.get_logger("TTSEngine")

# Default voice settings
DEFAULT_OPENAI_VOICE = "alloy"
DEFAULT_ELEVENLABS_VOICE = "Rachel"
DEFAULT_EDGE_VOICE = "ru-RU-DmitryNeural"


class TTSEngine:
    """Multi-provider Text-to-Speech engine with automatic fallback."""

    def __init__(self, config: Dict[str, Any]) -> None:
        tts_config = config.get("tts", {})
        self._provider_order: list[str] = tts_config.get("providers", ["openai", "elevenlabs", "edge"])
        self._openai_api_key: str = tts_config.get("openai_api_key", "") or os.getenv("OPENAI_API_KEY", "")
        self._openai_voice: str = tts_config.get("openai_voice", DEFAULT_OPENAI_VOICE)
        self._openai_model: str = tts_config.get("openai_model", "tts-1")
        self._elevenlabs_api_key: str = tts_config.get("elevenlabs_api_key", "") or os.getenv("ELEVENLABS_API_KEY", "")
        self._elevenlabs_voice: str = tts_config.get("elevenlabs_voice", DEFAULT_ELEVENLABS_VOICE)
        self._edge_voice: str = tts_config.get("edge_voice", DEFAULT_EDGE_VOICE)
        self._max_text_length: int = tts_config.get("max_text_length", 4096)

    async def synthesize(self, text: str, provider: Optional[str] = None) -> Optional[bytes]:
        """Convert text to speech audio (MP3 bytes).

        Args:
            text: The text to synthesize.
            provider: Force a specific provider. If None, tries the fallback chain.

        Returns:
            MP3 audio bytes, or None if all providers fail.
        """
        if not text or not text.strip():
            return None

        # Truncate overly long text
        if len(text) > self._max_text_length:
            text = text[:self._max_text_length] + "..."

        providers = [provider] if provider else self._provider_order

        for prov in providers:
            try:
                if prov == "openai":
                    result = await self._synthesize_openai(text)
                elif prov == "elevenlabs":
                    result = await self._synthesize_elevenlabs(text)
                elif prov == "edge":
                    result = await self._synthesize_edge(text)
                else:
                    logger.warning("Unknown TTS provider", provider=prov)
                    continue

                if result:
                    logger.info("TTS synthesis succeeded", provider=prov, text_len=len(text))
                    return result
            except Exception as e:
                logger.warning("TTS provider failed, trying next", provider=prov, error=str(e))

        logger.error("All TTS providers failed")
        return None

    async def _synthesize_openai(self, text: str) -> Optional[bytes]:
        """Synthesize via OpenAI TTS API."""
        if not self._openai_api_key:
            return None

        import aiohttp
        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://api.openai.com/v1/audio/speech",
                headers={
                    "Authorization": f"Bearer {self._openai_api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self._openai_model,
                    "input": text,
                    "voice": self._openai_voice,
                    "response_format": "mp3",
                },
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    return await resp.read()
                body = await resp.text()
                logger.warning("OpenAI TTS error", status=resp.status, body=body[:200])
                return None

    async def _synthesize_elevenlabs(self, text: str) -> Optional[bytes]:
        """Synthesize via ElevenLabs API."""
        if not self._elevenlabs_api_key:
            return None

        import aiohttp
        # Resolve voice ID (use name as-is if it looks like an ID)
        voice_id = self._elevenlabs_voice
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers={
                    "xi-api-key": self._elevenlabs_api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "model_id": "eleven_multilingual_v2",
                    "voice_settings": {
                        "stability": 0.5,
                        "similarity_boost": 0.75,
                    },
                },
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    return await resp.read()
                body = await resp.text()
                logger.warning("ElevenLabs TTS error", status=resp.status, body=body[:200])
                return None

    async def _synthesize_edge(self, text: str) -> Optional[bytes]:
        """Synthesize via edge-tts (free, no API key required)."""
        try:
            import edge_tts
        except ImportError:
            logger.debug("edge-tts not installed")
            return None

        import io
        communicate = edge_tts.Communicate(text, self._edge_voice)
        buffer = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buffer.write(chunk["data"])
        audio_data = buffer.getvalue()
        return audio_data if audio_data else None
