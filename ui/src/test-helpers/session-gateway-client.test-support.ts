type Row = Record<string, unknown>;
export function sessionClient<Result extends { payload: Row }>(
  request: (method: string, params?: Row) => Promise<Result>,
  key: string,
) {
  const payload = async (method: string, params?: Row) => (await request(method, params)).payload;
  return {
    payload,
    rows: async () => (await payload("sessions.list")).sessions,
    session: async () => (await payload("sessions.describe", { key })).session,
    patch: (params: Row) => request("sessions.patch", { key, ...params }),
    abort: (params: Row = {}) => payload("chat.abort", { sessionKey: key, ...params }),
    transcript: (method = "chat.startup", params: Row = {}) =>
      payload(method, { sessionKey: key, ...params }),
  };
}
