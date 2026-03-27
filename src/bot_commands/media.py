"""Photo, voice, video, and document media handlers."""

import base64
import io

import aiohttp
import structlog
from aiogram.types import Message
from prometheus_client import Counter

logger = structlog.get_logger("BotCommands.Media")

PHOTO_PROMPT_COUNTER = Counter("openclaw_prompts_photo", "Photo prompts received")
VIDEO_PROMPT_COUNTER = Counter("openclaw_prompts_video", "Video prompts received")


async def handle_photo(gateway, message: Message):
    """Handle image inputs via Vision-capable LLM (Phase 8: route_llm with multimodal)."""
    if message.from_user.id != gateway.admin_id:
        return

    PHOTO_PROMPT_COUNTER.inc()
    status_msg = await message.reply("🖼️ Анализирую изображение через Vision Pipeline...")

    try:
        photo = message.photo[-1]
        file_info = await gateway.bot.get_file(photo.file_id)
        file_bytes = await gateway.bot.download_file(file_info.file_path)
        base64_img = base64.b64encode(file_bytes.read()).decode("utf-8")

        prompt = message.caption or "Опиши это изображение подробно. Что ты видишь?"

        # Use Unified LLM Gateway with vision support (auto-selects vision model)
        from src.llm_gateway import route_llm

        result = await route_llm(
            prompt,
            task_type="vision",
            max_tokens=1536,
            image_base64=base64_img,
        )

        if result:
            await status_msg.edit_text(
                f"🖼️ *Vision Analysis:*\n\n{result}",
                parse_mode="Markdown",
            )
        else:
            await status_msg.edit_text("⚠️ Vision модель не вернула результат.")

        # Record in pipeline tree for Mission Control
        try:
            from src.web.api import record_pipeline_tree
            record_pipeline_tree({
                "type": "vision",
                "prompt": prompt[:200],
                "model": "auto-vision",
                "result_len": len(result) if result else 0,
            })
        except Exception:
            pass

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
    """Transcribe audio bytes using vLLM whisper endpoint or local fallback."""
    # Try vLLM /audio/transcriptions endpoint first (OpenAI-compatible)
    try:
        form = aiohttp.FormData()
        form.add_field("file", audio_data, filename="voice.ogg", content_type="audio/ogg")
        form.add_field("model", "whisper-1")

        base_url = gateway.vllm_url.replace("/v1", "")
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{base_url}/v1/audio/transcriptions",
                data=form,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    return result.get("text", "")
    except Exception as e:
        logger.debug("Whisper API transcription failed", error=str(e))

    # Fallback: use whisper-cpp via subprocess if available
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

    # Fallback: use openai-whisper Python package
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


async def handle_video(gateway, message: Message):
    """Handle video inputs — extract keyframes and route to video_analyst model (Nemotron VL)."""
    if message.from_user.id != gateway.admin_id:
        return

    VIDEO_PROMPT_COUNTER.inc()
    video = message.video or (message.video_note if hasattr(message, 'video_note') else None)
    if not video:
        return

    # Size guard: max 20 MB for video analysis
    file_size = getattr(video, 'file_size', 0) or 0
    if file_size > 20 * 1024 * 1024:
        await message.reply("⚠️ Видео слишком большое (макс. 20 МБ для анализа).")
        return

    status_msg = await message.reply("🎬 Загружаю видео для анализа через NVIDIA Nemotron VL...")

    try:
        file_info = await gateway.bot.get_file(video.file_id)
        file_bytes = await gateway.bot.download_file(file_info.file_path)
        raw = file_bytes.read()

        # Extract keyframes using opencv if available, otherwise send single thumbnail
        frames_b64 = await _extract_keyframes(raw)

        if not frames_b64:
            await status_msg.edit_text("⚠️ Не удалось извлечь кадры из видео.")
            return

        await status_msg.edit_text(
            f"🎬 Извлечено {len(frames_b64)} кадров. Отправляю на анализ..."
        )

        prompt = message.caption or (
            "Проведи детальный покадровый анализ этого видео. "
            "Опиши: объекты, действия, сцены, настроение, ключевые события."
        )

        # Route to video_analyst model via llm_gateway
        from src.llm_gateway import route_llm

        # Use first frame for single-image vision API (multi-frame via system prompt context)
        frame_descriptions = []
        for i, frame_b64 in enumerate(frames_b64[:4]):  # Analyze up to 4 keyframes
            frame_prompt = f"Кадр {i + 1}/{len(frames_b64)}. {prompt}" if i > 0 else prompt
            model = gateway.config.get("system", {}).get("model_router", {}).get(
                "video_analyst", "nvidia/nemotron-nano-vl"
            )
            result = await route_llm(
                frame_prompt,
                task_type="vision",
                model=model,
                max_tokens=1024,
                image_base64=frame_b64,
                system=(
                    "Ты — видео-аналитик NVIDIA Nemotron VL. "
                    "Проводи событийный анализ с глубиной, сопоставимой с Gemini 1.5 Pro. "
                    "Описывай: объекты, действия, контекст, эмоции, временную динамику."
                ),
            )
            if result:
                frame_descriptions.append(f"🖼 **Кадр {i + 1}:**\n{result}")

        if frame_descriptions:
            full_analysis = "\n\n".join(frame_descriptions)
            # Split if too long
            if len(full_analysis) > 3800:
                full_analysis = full_analysis[:3800] + "\n\n[...усечено]"
            await status_msg.edit_text(
                f"🎬 *Video Analysis (NVIDIA Nemotron VL):*\n\n{full_analysis}",
                parse_mode="Markdown",
            )
        else:
            await status_msg.edit_text("⚠️ Видео-аналитик не вернул результат.")

    except Exception as e:
        logger.error("Video handler failed", error=str(e))
        await status_msg.edit_text(f"❌ Ошибка обработки видео: {e}")


async def _extract_keyframes(video_bytes: bytes, max_frames: int = 4) -> list[str]:
    """Extract evenly-spaced keyframes from video as base64 JPEG strings.
    
    Requires opencv-python; returns empty list if unavailable.
    """
    try:
        import cv2
        import numpy as np
        import tempfile
        import os

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            tmp.write(video_bytes)
            tmp_path = tmp.name

        cap = cv2.VideoCapture(tmp_path)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

        if total_frames <= 0:
            cap.release()
            os.unlink(tmp_path)
            return []

        # Pick evenly spaced frame indices
        step = max(1, total_frames // max_frames)
        indices = [i * step for i in range(max_frames) if i * step < total_frames]

        frames_b64: list[str] = []
        for idx in indices:
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ret, frame = cap.read()
            if ret:
                _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                frames_b64.append(base64.b64encode(buf.tobytes()).decode("utf-8"))

        cap.release()
        os.unlink(tmp_path)
        return frames_b64

    except ImportError:
        logger.warning("opencv-python not installed — video keyframe extraction unavailable")
        return []
    except Exception as e:
        logger.error("Keyframe extraction failed", error=str(e))
        return []


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
