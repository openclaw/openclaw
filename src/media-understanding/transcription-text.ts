/** Empty STT prompt echoes are not speech; match whole utterances, never prose fragments. */
export function isTranscriptArtifactText(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, " ").toLowerCase();
  return (
    normalized === "" ||
    normalized === "context:" ||
    normalized === "###" ||
    normalized === "transcribe the audio" ||
    normalized === "transcribe the audio."
  );
}
