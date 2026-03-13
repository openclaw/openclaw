import fetch from "node-fetch";

/**
 * Fetches AppFolio account data from the pseudo-API using the base URL from the environment.
 * @param endpoint The API endpoint (e.g., "/api/resident/123/balance")
 * @param options Optional fetch options
 */
export async function fetchAppFolioApi<T = unknown>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const baseUrl = process.env.APPFOLIO_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("APPFOLIO_API_BASE_URL is not set in environment");
  }
  const url = baseUrl.replace(/\/$/, "") + endpoint;
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error(`AppFolio API request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Example: Fetch current balance for a resident/unit
 */
export async function getCurrentBalance(residentId: string, unitId: string) {
  return fetchAppFolioApi(
    `/api/resident/${encodeURIComponent(residentId)}/unit/${encodeURIComponent(unitId)}/balance`,
  );
}

// Add more helpers as needed for other intents (amount owed, delinquency, etc.)
