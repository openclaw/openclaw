import os
import aiohttp
import asyncio
from typing import List


class TelegramArchivist:
    """
    Handles Telegram interactions for the OpenClaw system.
    Splits long technical logs, avoids rate limits, and updates
    users on what each agent is actively 'Thinking' about.
    """

    def __init__(self, bot_token: str, chat_id: str):
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.api_url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        self.max_length = 4096

    def split_message(self, text: str) -> List[str]:
        """Splits message safely to respect Telegram's 4096 char limit."""
        if len(text) <= self.max_length:
            return [text]

        parts = []
        while text:
            if len(text) <= self.max_length:
                parts.append(text)
                break

            # Find the best split point (newline or space)
            split_at = text.rfind('\n', 0, self.max_length)
            if split_at == -1:
                split_at = text.rfind(' ', 0, self.max_length)
                if split_at == -1:
                    split_at = self.max_length  # Hard split in the middle of a word

            parts.append(text[:split_at].strip())
            text = text[split_at:].strip()

        return parts

    async def send_status(self, agent_role: str, model_name: str, status: str):
        """Sends a short status update (e.g., 'Thinking', 'Checking Sandbox')."""
        r = self.escape_markdown(agent_role)
        m = self.escape_markdown(model_name)
        s = self.escape_markdown(status)
        # Literal ( ) around a code span must be escaped in MarkdownV2
        message = f"🤖 *{r}* \\(`{m}`\\) is currently:\n_{s}_\\.\\.\\."
        await self._send_to_telegram(message)

    async def send_summary(self, title: str, summary_text: str):
        """Summarizes tech logs and sends to Telegram handling character limits."""
        t = self.escape_markdown(title)
        s = self.escape_markdown(summary_text)
        full_text = f"📊 *{t}*\n\n{s}"
        parts = self.split_message(full_text)

        for i, part in enumerate(parts):
            if len(parts) > 1:
                # Append part counter if message is split
                part = f"{part}\n\n_(Part {i+1}/{len(parts)})_"
            await self._send_to_telegram(part)
            # Sleep to prevent hitting Telegram's rate limit
            # (usually ~30 msgs per sec, but 1-2 sec is safer for bots)
            await asyncio.sleep(1.0)

    def escape_markdown(self, text: str) -> str:
        """
        Escapes reserved characters for Telegram MarkdownV2.
        Characters to escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
        """
        escape_chars = r'_*[]()~`>#+-=|{}.!'
        return "".join(['\\' + char if char in escape_chars else char for char in text])

    async def _send_to_telegram(self, text: str):
        # We use MarkdownV2 for better support, but it requires strict escaping
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "MarkdownV2"
        }
        async with aiohttp.ClientSession() as session:
            try:
                async with session.post(self.api_url, json=payload) as response:
                    if response.status != 200:
                        resp_text = await response.text()
                        print(f"Failed to send Markdown message: {resp_text}")
                        # Fallback to plain text if it's a parse error
                        if "can't parse entities" in resp_text or "Bad Request" in resp_text:
                            print("Retrying as plain text...")
                            del payload["parse_mode"]
                            async with session.post(self.api_url, json=payload) as retry_resp:
                                if retry_resp.status != 200:
                                    print(f"Failed to send plain text message: {await retry_resp.text()}")
            except Exception as e:
                print(f"Error sending to Telegram: {e}")


# ======= Example Usage =======
if __name__ == "__main__":
    # In a real environment, load these from .env
    BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "YOUR_TELEGRAM_BOT_TOKEN")
    CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "YOUR_CHAT_ID")

    archivist = TelegramArchivist(BOT_TOKEN, CHAT_ID)

    async def run_demo():
        # 1. Status Update
        await archivist.send_status("Planner", "DeepSeek-R1-8B", "Creating Global Plan")

        await asyncio.sleep(2)

        # 2. Huge text that needs splitting
        huge_log = "Tech Log Entry. " * 500  # Will exceed 4096 characters limit
        human_readable = f"Here is the summarized execution log:\n{huge_log}"

        await archivist.send_summary("Architecture Execution Run", human_readable)

    if BOT_TOKEN != "YOUR_TELEGRAM_BOT_TOKEN":
        asyncio.run(run_demo())
    else:
        print("Please configure your Telegram bot credentials.")
