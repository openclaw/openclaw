import { transcribeDeepgramAudio } from "./audio.js";
export const deepgramProvider = {
    id: "deepgram",
    capabilities: ["audio"],
    transcribeAudio: transcribeDeepgramAudio,
};
