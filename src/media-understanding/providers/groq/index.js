import { transcribeOpenAiCompatibleAudio } from "../openai/audio.js";
const DEFAULT_GROQ_AUDIO_BASE_URL = "https://api.groq.com/openai/v1";
export const groqProvider = {
    id: "groq",
    capabilities: ["audio"],
    transcribeAudio: (req) => transcribeOpenAiCompatibleAudio({
        ...req,
        baseUrl: req.baseUrl ?? DEFAULT_GROQ_AUDIO_BASE_URL,
    }),
};
