import type { ChannelLogSink } from "../../../channels/plugins/types.core.js";
import type { TwilioClient } from "./client.js";

// @ts-ignore
import * as fs from "node:fs/promises";
// @ts-ignore
import * as fsSync from "node:fs";
const { createWriteStream } = fsSync;
// @ts-ignore
import * as path from "node:path";
// @ts-ignore
import * as os from "node:os";
// @ts-ignore
import * as child_process from "node:child_process";
const { execFile } = child_process;
// @ts-ignore
import * as util from "node:util";
const { promisify } = util;
// @ts-ignore
import * as streamPromises from "node:stream/promises";
const { pipeline } = streamPromises;
// @ts-ignore
import * as process from "node:process";

const execFileAsync = promisify(execFile);

// Configuration Constants (TODO: Move to config)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "eburon-orbit-2.3";
const EBURON_TTS_URL = process.env.EBURON_TTS_URL || "http://127.0.0.1:5002/api/tts";
const EBURON_STT_MODEL = process.env.EBURON_STT_MODEL || "base";

interface VoicePipelineParams {
    mediaUrl: string;
    from: string;
    to: string;
    client: TwilioClient;
    logger: ChannelLogSink;
}

async function downloadFile(url: string, destPath: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
    if (!response.body) throw new Error("No response body");
    const stream = createWriteStream(destPath);
    // @ts-ignore - Check fetch types in this env
    await pipeline(response.body, stream);
}

async function transcribeAudio(audioPath: string, logger: ChannelLogSink): Promise<string> {
    // Try Eburon STT (Whisper)
    try {
        logger.info("[VoicePipeline] Running Eburon STT...");
        const { stdout } = await execFileAsync("whisper", [
            audioPath,
            "--model", EBURON_STT_MODEL,
            "--output_format", "txt",
            "--output_dir", path.dirname(audioPath),
            "--verbose", "False"
        ]);

        // Read the output text file
        // whisper output naming can vary. We will try standard naming.
        const potentialPaths = [
            path.join(path.dirname(audioPath), path.basename(audioPath, path.extname(audioPath)) + ".txt"),
            audioPath + ".txt"
        ];

        for (const p of potentialPaths) {
            try {
                const content = await fs.readFile(p, "utf-8");
                if (content.trim()) return content.trim();
            } catch { }
        }

        return stdout.trim() || "";
    } catch (err: any) {
        throw new Error(`Whisper failed: ${err.message}`);
    }
}

async function askOllama(prompt: string, logger: ChannelLogSink): Promise<string> {
    logger.info(`[VoicePipeline] Querying Ollama (${OLLAMA_MODEL})...`);
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            messages: [{ role: "user", content: prompt }],
            stream: false
        })
    });

    if (!res.ok) throw new Error(`Ollama API error: ${res.status}`);
    const data: any = await res.json();
    return data.message?.content || "";
}

async function synthesizeSpeech(text: string, outputDir: string, logger: ChannelLogSink): Promise<string> {
    logger.info(`[VoicePipeline] Synthesizing speech with Eburon TTS...`);
    // Assuming Eburon TTS (Coqui) server is running
    const res = await fetch(`${EBURON_TTS_URL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            text: text,
            speaker_id: "p225", // Default speaker
            style_wav: "" // Optional cloning
        })
    });

    if (res.headers.get("content-type")?.includes("audio") || res.ok) {
        const destFile = path.join(outputDir, `response_${Date.now()}.wav`);
        const stream = createWriteStream(destFile);
        // @ts-ignore
        await pipeline(res.body, stream);
        return destFile;
    }

    throw new Error(`Coqui TTS failed: ${res.status}`);
}

export async function processVoicePipeline(params: VoicePipelineParams) {
    const { mediaUrl, from, client, logger } = params;
    const tmpDir = os.tmpdir();
    const inputAudio = path.join(tmpDir, `input_${Date.now()}.ogg`); // Twilio usually sends OGG/AMR

    try {
        // 1. Download
        await downloadFile(mediaUrl, inputAudio);

        // 2. STT
        const transcript = await transcribeAudio(inputAudio, logger);
        logger.info(`[VoicePipeline] Transcript: "${transcript}"`);
        if (!transcript) {
            await client.sendMessage(from, "I couldn't hear anything.");
            return;
        }

        // 3. LLM
        const replyText = await askOllama(transcript, logger);
        logger.info(`[VoicePipeline] Reply: "${replyText}"`);

        // 4. TTS
        // For now, we will just send the text back because serving the audio file via public URL 
        // (which Twilio requires to emit audio) is complex without a public storage bucket.
        // We will send text first.
        await client.sendMessage(from, replyText);

        // TODO: Upload generated audio to a public bucket (S3/Cloudinary) so Twilio can play it.
        // const audioFile = await synthesizeSpeech(replyText, tmpDir, logger);
        // const publicAudioUrl = await uploadToStorage(audioFile); 
        // await client.sendMessage(from, "", publicAudioUrl);

    } catch (err) {
        logger.error(`[VoicePipeline] Failed: ${err}`);
        await client.sendMessage(from, "Error processing voice message.");
    } finally {
        // Cleanup
        try { await fs.unlink(inputAudio).catch(() => { }); } catch { }
    }
}
