"""Discord Channel Handler — discord.py integration for OpenClaw.

Mirrors the Telegram handler pattern: receives messages, routes them
through the pipeline, and sends formatted responses back to Discord.

Usage:
    handler = DiscordHandler(config, pipeline)
    await handler.start()   # Blocks while running
    # or
    handler.run_in_background(loop)  # Non-blocking
"""

from __future__ import annotations

import asyncio
import os
from typing import TYPE_CHECKING, Any, Dict, Optional

import structlog

if TYPE_CHECKING:
    from src.pipeline_executor import PipelineExecutor

logger = structlog.get_logger("DiscordHandler")

# Discord message limit
DISCORD_MAX_LENGTH = 2000


class DiscordHandler:
    """Handles Discord interactions for the OpenClaw bot."""

    def __init__(
        self,
        config: Dict[str, Any],
        pipeline: Optional["PipelineExecutor"] = None,
    ) -> None:
        self.config = config
        self.pipeline = pipeline
        self._client: Any = None  # discord.Client instance
        self._token: str = config.get("discord", {}).get("token", "") or os.getenv("DISCORD_BOT_TOKEN", "")
        self._allowed_channels: list[str] = config.get("discord", {}).get("allowed_channels", [])
        self._command_prefix: str = config.get("discord", {}).get("command_prefix", "!")

    async def start(self) -> None:
        """Start the Discord bot. Blocks until disconnected."""
        try:
            import discord
        except ImportError:
            logger.warning("discord.py not installed — Discord handler disabled. Install with: pip install discord.py")
            return

        if not self._token:
            logger.warning("No Discord token configured — Discord handler disabled")
            return

        intents = discord.Intents.default()
        intents.message_content = True
        self._client = discord.Client(intents=intents)

        @self._client.event
        async def on_ready() -> None:
            logger.info("Discord bot connected", user=str(self._client.user), guilds=len(self._client.guilds))

        @self._client.event
        async def on_message(message: discord.Message) -> None:
            # Ignore own messages
            if message.author == self._client.user:
                return

            # Channel filter
            if self._allowed_channels and str(message.channel.id) not in self._allowed_channels:
                return

            # Only respond to mentions or command prefix
            content = message.content.strip()
            is_mention = self._client.user in message.mentions if self._client.user else False
            is_command = content.startswith(self._command_prefix)

            if not is_mention and not is_command:
                return

            # Strip prefix/mention
            if is_command:
                prompt = content[len(self._command_prefix):].strip()
            else:
                prompt = content.replace(f"<@{self._client.user.id}>", "").strip() if self._client.user else content

            if not prompt:
                return

            logger.info("Discord message received", author=str(message.author), channel=str(message.channel.id), prompt_len=len(prompt))

            await self._handle_prompt(message, prompt)

        await self._client.start(self._token)

    def run_in_background(self, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        """Start Discord bot in a background task (non-blocking)."""
        _loop = loop or asyncio.get_event_loop()
        _loop.create_task(self.start())

    async def shutdown(self) -> None:
        """Gracefully close the Discord client."""
        if self._client:
            await self._client.close()
            logger.info("Discord bot disconnected")

    async def _handle_prompt(self, message: Any, prompt: str) -> None:
        """Route the prompt through the pipeline and send the response with streaming."""
        if not self.pipeline:
            await self._send(message.channel, "⚠️ Pipeline not available.")
            return

        try:
            async with message.channel.typing():
                result = await self.pipeline.execute_stream(
                    prompt=prompt,
                    brigade="OpenClaw-Core",
                    task_type=None,
                )
                stream = result.get("stream")
                if stream:
                    # Progressive message editing (nanobot-style streaming)
                    accumulated = ""
                    sent_msg = None
                    edit_counter = 0
                    async for chunk in stream:
                        accumulated += chunk
                        edit_counter += 1
                        # Edit every 4 chunks to avoid rate limits
                        if edit_counter % 4 == 0 or len(accumulated) < 100:
                            try:
                                if sent_msg is None:
                                    sent_msg = await message.channel.send(accumulated[:DISCORD_MAX_LENGTH])
                                elif len(accumulated) <= DISCORD_MAX_LENGTH:
                                    await sent_msg.edit(content=accumulated)
                            except Exception:
                                pass  # Rate limit or edit failure — continue accumulating
                    # Final edit with complete text
                    if sent_msg and accumulated:
                        try:
                            if len(accumulated) <= DISCORD_MAX_LENGTH:
                                await sent_msg.edit(content=accumulated)
                            else:
                                # Text exceeds limit — send remaining as new messages
                                await sent_msg.edit(content=accumulated[:DISCORD_MAX_LENGTH])
                                for part in self._split_message(accumulated[DISCORD_MAX_LENGTH:]):
                                    await message.channel.send(part)
                        except Exception:
                            pass
                    elif not sent_msg:
                        # Stream was empty, fallback to non-streaming response
                        response = result.get("final_response", "⚠️ No response generated.")
                        await self._send(message.channel, response)
                else:
                    response = result.get("final_response", "⚠️ No response generated.")
                    await self._send(message.channel, response)
        except Exception as e:
            logger.error("Discord prompt handling failed", error=str(e))
            await self._send(message.channel, f"⚠️ Error: {str(e)[:200]}")

    async def _send(self, channel: Any, text: str) -> None:
        """Send a message to a Discord channel, splitting if needed."""
        parts = self._split_message(text)
        for part in parts:
            await channel.send(part)
            await asyncio.sleep(0.5)  # Rate limit safety

    @staticmethod
    def _split_message(text: str) -> list[str]:
        """Split a message to fit within Discord's 2000 char limit."""
        if len(text) <= DISCORD_MAX_LENGTH:
            return [text]

        parts: list[str] = []
        while text:
            if len(text) <= DISCORD_MAX_LENGTH:
                parts.append(text)
                break
            split_at = text.rfind("\n", 0, DISCORD_MAX_LENGTH)
            if split_at == -1:
                split_at = text.rfind(" ", 0, DISCORD_MAX_LENGTH)
                if split_at == -1:
                    split_at = DISCORD_MAX_LENGTH
            parts.append(text[:split_at].strip())
            text = text[split_at:].strip()
        return parts
