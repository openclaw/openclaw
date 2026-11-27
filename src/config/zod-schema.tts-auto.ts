import { z } from "zod";

export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);
