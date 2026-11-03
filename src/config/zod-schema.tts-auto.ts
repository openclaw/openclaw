// Runtime TTS normalization must not initialize the complete core config schema.
import { z } from "zod";

export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
