/**
 * list.affitor.com API client
 * Handles both public (no key, max 5 results) and authenticated access
 */

const API_BASE = "https://list.affitor.com/api/v1";

export interface Program {
  id: string;
  slug: string;
  name: string;
  url: string | null;
  description: string;
  reward_type: string | null;
  reward_value: string | null;
  cookie_days: number | null;
  stars_count: number;
  views_count: number;
  comments_count: number;
  category: string | null;
  tags: string[] | null;
  type: string;
  stage: string | null;
  status: string;
  created_at: string;
  profiles: {
    handle: string | null;
    avatar_url: string | null;
    name: string | null;
  };
}

export interface ProgramsResponse {
  data: Program[];
  count: number;
  tier?: "free";
  message?: string;
}

export interface SearchParams {
  q?: string;
  type?: "affiliate_program" | "skill";
  sort?: "trending" | "new" | "top";
  limit?: number;
  offset?: number;
  reward_type?: string;
  tags?: string;
  min_cookie_days?: number;
}

export async function fetchPrograms(
  params: SearchParams,
  apiKey?: string,
): Promise<ProgramsResponse> {
  const url = new URL(`${API_BASE}/programs`);

  if (params.q) url.searchParams.set("q", params.q);
  if (params.type) url.searchParams.set("type", params.type);
  if (params.sort) url.searchParams.set("sort", params.sort);
  if (params.limit) url.searchParams.set("limit", String(params.limit));
  if (params.offset) url.searchParams.set("offset", String(params.offset));
  if (params.reward_type) url.searchParams.set("reward_type", params.reward_type);
  if (params.tags) url.searchParams.set("tags", params.tags);
  if (params.min_cookie_days)
    url.searchParams.set("min_cookie_days", String(params.min_cookie_days));

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "affiliate-check/1.0",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url.toString(), { headers });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401) {
      throw new Error("Invalid API key. Get one at list.affitor.com/settings → API Keys (free).");
    }
    if (response.status === 403) {
      throw new Error(
        "API key missing 'programs:read' scope. Create a new key with the correct scope.",
      );
    }
    if (response.status === 429) {
      throw new Error(
        "Rate limit exceeded. Try again later or use an API key for unlimited access.",
      );
    }
    throw new Error(`API error (${response.status}): ${body}`);
  }

  return response.json() as Promise<ProgramsResponse>;
}

export async function fetchProgram(id: string, apiKey?: string): Promise<Program | null> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "affiliate-check/1.0",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(`${API_BASE}/programs/${id}`, { headers });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`API error (${response.status})`);
  }

  const json = await response.json();
  return json.data as Program;
}
