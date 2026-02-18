import type { ServerResponse } from "node:http";

export function createMockServerResponse(): ServerResponse & { body?: string } {
  const headers: Record<string, string> = {};
  const res: {
    headersSent: boolean;
    statusCode: number;
    body?: string;
    setHeader: (key: string, value: string) => unknown;
    end: (body?: string) => unknown;
  } = {
    headersSent: false,
    statusCode: 200,
    setHeader: (key: string, value: string) => {
      headers[key.toLowerCase()] = value;
      return res;
    },
    end: (body?: string) => {
      res.headersSent = true;
      res.body = body;
      return res;
    },
  };
  return res as unknown as ServerResponse & { body?: string };
}
