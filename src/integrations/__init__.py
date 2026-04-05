"""Integrations — external service connectors, RAG, TTS, research, REST API.

Submodules:
  - archivist_telegram : Telegram message splitter + status updates + rate limiting
  - discord_handler    : Discord message handler
  - tailscale_monitor  : Tailscale IP monitor
  - tts_engine         : Multi-provider TTS (edge-tts, etc.)
  - rag_engine         : ChromaDB-based retrieval (Markdown chunking + cosine similarity)
  - research_enhanced  : Multi-perspective research + evidence scoring
  - brigade_api        : FastAPI REST server (HTTP bridge for TS gateway)
"""

from src.integrations.archivist_telegram import TelegramArchivist
from src.integrations.rag_engine import RAGEngine

__all__ = ["TelegramArchivist", "RAGEngine"]
