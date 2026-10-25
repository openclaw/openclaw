import { vi } from "vitest";
import { mediaTicketPayload } from "../../../test-helpers/control-ui-attachment-fixtures.ts";

export const managedSource = (id: string = crypto.randomUUID()) =>
  `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`;

export const imageResponse = () =>
  new Response("png", { headers: { "Content-Type": "image/png" } });

export function ticketResponse(mediaTicket = "image-ticket", expiresIn = 300_000) {
  return Response.json(mediaTicketPayload(mediaTicket, expiresIn));
}

export function stubObjectUrls(
  create: (object: Blob | MediaSource) => string = () => `blob:${crypto.randomUUID()}`,
  revoke = vi.fn(),
) {
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL = create;
      static override revokeObjectURL = revoke;
    },
  );
  return revoke;
}
