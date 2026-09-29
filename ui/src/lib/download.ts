export function downloadTextFile(filename: string, content: string, type = "text/plain"): void {
  downloadBlobFile(filename, new Blob([content], { type }));
}

export function downloadBlobFile(filename: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Let the browser consume the click before releasing the download payload.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
