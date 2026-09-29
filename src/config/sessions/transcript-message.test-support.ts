export function transcriptMessage(eventId: string, parentId: string | null, message: unknown) {
  return { eventId, parentId, message };
}
