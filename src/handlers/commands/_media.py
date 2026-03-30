"""Media handlers: photo (vision), voice (STT), document (PDF/TXT)."""

import base64
import io

import structlog
from aiogram.types import Message
from src.bot_commands.media import PHOTO_PROMPT_COUNTER
from src.llm_gateway import route_llm

logger = structlog.get_logger("GatewayCommands.Media")


async def handle_photo(gateway, message: Message):
    """Handle image inputs via cloud vision model."""
    if message.from_user.id != gateway.admin_id:
        return

    PHOTO_PROMPT_COUNTER.inc()
    status_msg = await message.reply("🖼️ Анализирую изображение через Vision...")

    try:
        photo = message.photo[-1]
        file_info = await gateway.bot.get_file(photo.file_id)
        file_bytes = await gateway.bot.download_file(file_info.file_path)
        base64_img = base64.b64encode(file_bytes.read()).decode("utf-8")

        prompt = message.caption or "Опиши это изображение"

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_img}"}},
                ],
            }
        ]

        content = await route_llm(
            "",
            messages=messages,
            task_type="vision",
            max_tokens=1024,
        )

        if content:
            await status_msg.edit_text(
                f"🖼️ *Анализ Vision:*\n\n{content}",
                parse_mode="Markdown",
            )
        else:
            await status_msg.edit_text("⚠️ Ошибка Vision: пустой ответ от API")
    except Exception as e:
        await status_msg.edit_text(f"❌ Ошибка обработки фото: {e}")


async def handle_voice(gateway, message: Message):
    """Transcribe voice message to text, then route to brigade pipeline."""
    if message.from_user.id != gateway.admin_id:
        return

    status_msg = await message.reply("🎤 Распознаю голосовое сообщение...")
    try:
        voice = message.voice
        file_info = await gateway.bot.get_file(voice.file_id)
        file_bytes = await gateway.bot.download_file(file_info.file_path)
        audio_data = file_bytes.read()

        transcribed_text = await _transcribe_audio(gateway, audio_data)

        if not transcribed_text or not transcribed_text.strip():
            await status_msg.edit_text("⚠️ Не удалось распознать голосовое сообщение.")
            return

        await status_msg.edit_text(
            f"🎤 *Распознано:* {transcribed_text}\n\n⏳ Отправляю в бригаду...",
            parse_mode="Markdown",
        )

        class VoiceTextMessage:
            def __init__(self, original, text):
                self.text = text
                self.from_user = original.from_user
                self.chat = original.chat
                self.reply_to_message = None
                self.bot = original.bot

            async def reply(self, *args, **kwargs):
                return await original.reply(*args, **kwargs)

        voice_msg = VoiceTextMessage(message, transcribed_text)
        await gateway.handle_prompt(voice_msg)

    except Exception as e:
        logger.error("Voice handler failed", error=str(e))
        await status_msg.edit_text(f"❌ Ошибка обработки голоса: {e}")


async def _transcribe_audio(gateway, audio_data: bytes) -> str:
    """Transcribe audio bytes using local whisper fallbacks."""
    # Fallback: whisper-cpp via subprocess
    try:
        import tempfile
        import subprocess
        import os

        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
            tmp.write(audio_data)
            tmp_path = tmp.name
        result = subprocess.run(
            ["whisper-cpp", "-m", "models/ggml-base.bin", "-f", tmp_path, "--output-txt"],
            capture_output=True, text=True, timeout=30,
        )
        os.unlink(tmp_path)
        txt_path = tmp_path + ".txt"
        if os.path.exists(txt_path):
            with open(txt_path, "r") as f:
                text = f.read().strip()
            os.unlink(txt_path)
            return text
        return result.stdout.strip()
    except Exception as e:
        logger.debug("Whisper CLI transcription failed", error=str(e))

    # Fallback: openai-whisper Python package
    try:
        import tempfile
        import os
        import whisper

        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
            tmp.write(audio_data)
            tmp_path = tmp.name
        model = whisper.load_model("base")
        result = model.transcribe(tmp_path, language="ru")
        os.unlink(tmp_path)
        return result.get("text", "")
    except Exception as e:
        logger.warning("All STT backends failed", error=str(e))
        return ""


async def handle_document(gateway, message: Message):
    """Extract text from PDF/TXT documents and send to brigade pipeline."""
    if message.from_user.id != gateway.admin_id:
        return

    doc = message.document
    if not doc:
        return

    fname = (doc.file_name or "").lower()
    supported = fname.endswith((".txt", ".pdf", ".md", ".py", ".json", ".csv", ".log"))
    if not supported:
        await message.reply(f"⚠️ Формат `{fname.rsplit('.', 1)[-1]}` не поддерживается. Поддерживаются: txt, pdf, md, py, json, csv, log")
        return

    status_msg = await message.reply(f"📎 Обрабатываю `{doc.file_name}`...")

    try:
        file_info = await gateway.bot.get_file(doc.file_id)
        file_bytes = await gateway.bot.download_file(file_info.file_path)
        raw = file_bytes.read()

        if fname.endswith(".pdf"):
            text = _extract_pdf_text(raw)
        else:
            text = raw.decode("utf-8", errors="replace")

        if not text.strip():
            await status_msg.edit_text("⚠️ Документ пуст или не удалось извлечь текст.")
            return

        if len(text) > 6000:
            text = text[:6000] + "\n\n[...усечено]"

        caption = message.caption or "Проанализируй этот документ"
        combined_prompt = f"{caption}\n\n--- Содержимое документа ({doc.file_name}) ---\n{text}"

        await status_msg.edit_text(
            f"📎 Извлечено {len(text)} символов из `{doc.file_name}`\n⏳ Отправляю в бригаду...",
            parse_mode="Markdown",
        )

        class DocTextMessage:
            def __init__(self, original, text):
                self.text = text
                self.from_user = original.from_user
                self.chat = original.chat
                self.reply_to_message = None
                self.bot = original.bot

            async def reply(self, *args, **kwargs):
                return await original.reply(*args, **kwargs)

        doc_msg = DocTextMessage(message, combined_prompt)
        await gateway.handle_prompt(doc_msg)

    except Exception as e:
        logger.error("Document handler failed", error=str(e))
        await status_msg.edit_text(f"❌ Ошибка обработки документа: {e}")


def _extract_pdf_text(raw_bytes: bytes) -> str:
    """Extract text from PDF bytes using PyMuPDF or pdfminer fallback."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=raw_bytes, filetype="pdf")
        text_parts = []
        for page in doc:
            text_parts.append(page.get_text())
        doc.close()
        return "\n".join(text_parts)
    except ImportError:
        pass

    try:
        from pdfminer.high_level import extract_text
        return extract_text(io.BytesIO(raw_bytes))
    except ImportError:
        pass

    return "[Ошибка: для PDF установите PyMuPDF (pip install pymupdf) или pdfminer.six]"
