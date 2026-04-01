const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

type GraphMailCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  userEmail: string;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

function resolveMailCredentials(): GraphMailCredentials {
  const tenantId = process.env.MS_GRAPH_TENANT_ID?.trim();
  const clientId = process.env.MS_GRAPH_CLIENT_ID?.trim();
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET?.trim();
  const userEmail = process.env.MS_GRAPH_USER_EMAIL?.trim();
  if (!tenantId || !clientId || !clientSecret || !userEmail) {
    throw new Error(
      "MS Graph credentials missing. Set MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET, MS_GRAPH_USER_EMAIL in .env",
    );
  }
  return { tenantId, clientId, clientSecret, userEmail };
}

async function acquireToken(creds: GraphMailCredentials): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token acquisition failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return cachedToken.token;
}

async function graphFetch<T>(
  path: string,
  options?: RequestInit & { headers?: Record<string, string> },
): Promise<T> {
  const creds = resolveMailCredentials();
  const token = await acquireToken(creds);
  const res = await fetch(`${GRAPH_ROOT}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...((options?.headers ?? {}) as Record<string, string>),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API ${path} failed (${res.status}): ${text}`);
  }
  if (res.status === 204) {
    return {} as T;
  }
  return (await res.json()) as T;
}

function userPath(): string {
  const creds = resolveMailCredentials();
  return `/users/${encodeURIComponent(creds.userEmail)}`;
}

// --- Public API ---

export type GraphMessage = {
  id: string;
  subject: string;
  from?: { emailAddress: { name: string; address: string } };
  toRecipients?: { emailAddress: { name: string; address: string } }[];
  receivedDateTime: string;
  isRead: boolean;
  bodyPreview: string;
  body?: { contentType: string; content: string };
  categories?: string[];
  parentFolderId?: string;
  hasAttachments?: boolean;
};

export type GraphFolder = {
  id: string;
  displayName: string;
  totalItemCount: number;
  unreadItemCount: number;
};

export async function listEmails(options?: {
  folderId?: string;
  top?: number;
  skip?: number;
  search?: string;
  filter?: string;
  select?: string;
}): Promise<{ messages: GraphMessage[]; totalCount?: number }> {
  const base = options?.folderId
    ? `${userPath()}/mailFolders/${encodeURIComponent(options.folderId)}/messages`
    : `${userPath()}/messages`;
  const params = new URLSearchParams();
  params.set("$top", String(options?.top ?? 10));
  if (options?.skip) {
    params.set("$skip", String(options.skip));
  }
  if (options?.search) {
    params.set("$search", `"${options.search}"`);
  }
  if (options?.filter) {
    params.set("$filter", options.filter);
  }
  params.set(
    "$select",
    options?.select ??
      "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,categories,parentFolderId,hasAttachments",
  );
  params.set("$orderby", "receivedDateTime desc");
  params.set("$count", "true");
  const result = await graphFetch<{ value: GraphMessage[]; "@odata.count"?: number }>(
    `${base}?${params.toString()}`,
    { headers: { ConsistencyLevel: "eventual" } },
  );
  return { messages: result.value ?? [], totalCount: result["@odata.count"] };
}

export async function readEmail(messageId: string): Promise<GraphMessage> {
  return graphFetch<GraphMessage>(
    `${userPath()}/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,toRecipients,receivedDateTime,isRead,body,bodyPreview,categories,parentFolderId,hasAttachments`,
  );
}

export async function sendEmail(params: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyType?: "Text" | "HTML";
}): Promise<void> {
  const toRecipients = params.to.map((addr) => ({
    emailAddress: { address: addr },
  }));
  const ccRecipients = params.cc?.map((addr) => ({
    emailAddress: { address: addr },
  }));
  await graphFetch(`${userPath()}/sendMail`, {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject: params.subject,
        body: { contentType: params.bodyType ?? "Text", content: params.body },
        toRecipients,
        ...(ccRecipients?.length ? { ccRecipients } : {}),
      },
    }),
  });
}

export async function replyToEmail(messageId: string, comment: string): Promise<void> {
  await graphFetch(`${userPath()}/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
}

export async function forwardEmail(
  messageId: string,
  to: string[],
  comment?: string,
): Promise<void> {
  const toRecipients = to.map((addr) => ({
    emailAddress: { address: addr },
  }));
  await graphFetch(`${userPath()}/messages/${encodeURIComponent(messageId)}/forward`, {
    method: "POST",
    body: JSON.stringify({ comment: comment ?? "", toRecipients }),
  });
}

export async function moveEmail(
  messageId: string,
  destinationFolderId: string,
): Promise<GraphMessage> {
  return graphFetch<GraphMessage>(`${userPath()}/messages/${encodeURIComponent(messageId)}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId: destinationFolderId }),
  });
}

export async function categorizeEmail(
  messageId: string,
  categories: string[],
): Promise<GraphMessage> {
  return graphFetch<GraphMessage>(`${userPath()}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ categories }),
  });
}

export async function listFolders(): Promise<GraphFolder[]> {
  const result = await graphFetch<{ value: GraphFolder[] }>(
    `${userPath()}/mailFolders?$top=50&$select=id,displayName,totalItemCount,unreadItemCount`,
  );
  return result.value ?? [];
}

export async function listChildFolders(parentFolderId: string): Promise<GraphFolder[]> {
  const result = await graphFetch<{ value: GraphFolder[] }>(
    `${userPath()}/mailFolders/${encodeURIComponent(parentFolderId)}/childFolders?$top=50&$select=id,displayName,totalItemCount,unreadItemCount`,
  );
  return result.value ?? [];
}

export async function markAsRead(messageId: string, isRead: boolean): Promise<void> {
  await graphFetch(`${userPath()}/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ isRead }),
  });
}
