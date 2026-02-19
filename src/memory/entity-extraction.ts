
export type EntityType =
  | "PERSON"
  | "ORGANIZATION"
  | "LOCATION"
  | "DATE"
  | "TIME"
  | "MONEY"
  | "PERCENT"
  | "PRODUCT"
  | "EVENT"
  | "WORK_OF_ART"
  | "LAW"
  | "LANGUAGE"
  | "CONCEPT"
  | "CUSTOM";

export type ExtractedEntity = {
  name: string;
  type: EntityType;
  confidence: number;
  offset?: number;
  length?: number;
  context?: string;
};

export type ExtractedRelationship = {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
};

export type EntityExtractionResult = {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
};

const ENTITY_EXTRACTION_PROMPT = `Extract entities and relationships from the following text.

Entity types: PERSON, ORGANIZATION, LOCATION, DATE, PRODUCT, EVENT, CONCEPT, CUSTOM

Return ONLY valid JSON in this format:
{
  "entities": [
    {"name": "Entity Name", "type": "PERSON", "confidence": 0.95}
  ],
  "relationships": [
    {"subject": "Entity1", "predicate": "WORKS_AT", "object": "Entity2", "confidence": 0.9}
  ]
}

Text:
{text}
`;

export type EntityExtractorConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export async function extractEntitiesWithLLM(params: {
  text: string;
  config: EntityExtractorConfig;
  maxEntities?: number;
}): Promise<EntityExtractionResult> {
  const maxEntities = params.maxEntities ?? 50;

  try {
    const prompt = ENTITY_EXTRACTION_PROMPT.replace("{text}", params.text.slice(0, 4000));

    const response = await fetchWithTimeout(params.config, prompt, 30000);
    const json = parseExtractionJson(response);

    return {
      entities: (json.entities ?? []).slice(0, maxEntities).map(normalizeEntity),
      relationships: (json.relationships ?? []).slice(0, maxEntities).map(normalizeRelationship),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[entity-extraction] Failed:", message);
    return { entities: [], relationships: [] };
  }
}

async function fetchWithTimeout(
  config: EntityExtractorConfig,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content: "You are an entity extraction specialist. Output only valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content ?? "";
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function parseExtractionJson(text: string): Partial<EntityExtractionResult> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeEntity(entity: unknown): ExtractedEntity {
  const e = entity as Record<string, unknown>;
  return {
    name: String(e.name ?? "").trim(),
    type: isValidEntityType(String(e.type)) ? (e.type as EntityType) : "CUSTOM",
    confidence: typeof e.confidence === "number" ? e.confidence : 0.8,
  };
}

function normalizeRelationship(rel: unknown): ExtractedRelationship {
  const r = rel as Record<string, unknown>;
  return {
    subject: String(r.subject ?? "").trim(),
    predicate: String(r.predicate ?? "RELATED_TO").trim(),
    object: String(r.object ?? "").trim(),
    confidence: typeof r.confidence === "number" ? r.confidence : 0.8,
  };
}

function isValidEntityType(type: string): type is EntityType {
  const valid: EntityType[] = [
    "PERSON",
    "ORGANIZATION",
    "LOCATION",
    "DATE",
    "TIME",
    "MONEY",
    "PERCENT",
    "PRODUCT",
    "EVENT",
    "WORK_OF_ART",
    "LAW",
    "LANGUAGE",
    "CONCEPT",
    "CUSTOM",
  ];
  return valid.includes(type as EntityType);
}

export function generateEntityId(name: string, type: string): string {
  const normalized = `${type}:${name.toLowerCase().trim()}`;
  return hashString(normalized);
}

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
