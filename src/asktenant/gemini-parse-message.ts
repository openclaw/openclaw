import { SchemaType, VertexAI } from "@google-cloud/vertexai";

export type ParsedMessage = {
  intent: string;
  entity_scope: "unit" | "property" | "account";
  confidence: number;
  requires_auth: boolean;
};

const vertexAI = new VertexAI({
  project: process.env.GCP_PROJECT_ID || "asktenant-ai",
  location: process.env.VERTEX_LOCATION || "us-central1",
});

const model = vertexAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
});

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    intent: { type: SchemaType.STRING },
    entity_scope: { type: SchemaType.STRING, enum: ["unit", "property", "account"] },
    confidence: { type: SchemaType.NUMBER },
    requires_auth: { type: SchemaType.BOOLEAN },
  },
  required: ["intent", "entity_scope", "confidence", "requires_auth"],
};

export async function parseMessage(message: string): Promise<ParsedMessage> {
  const prompt = [
    "Extract the intent and key entities from this resident message.",
    "Return JSON only.",
    "",
    "Schema:",
    JSON.stringify(responseSchema),
    "",
    "Message:",
    message,
  ].join("\n");

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no text content");
  }

  const parsed = JSON.parse(text) as ParsedMessage;

  if (!parsed.intent || typeof parsed.confidence !== "number") {
    throw new Error("Gemini returned invalid parse payload");
  }

  return parsed;
}
