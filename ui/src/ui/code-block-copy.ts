const COPIED_FOR_MS = 1500;

export function handleCodeBlockCopyClick(e: Event): void {
  const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".code-block-copy");
  if (!btn) {
    return;
  }

  const code = btn.dataset.code ?? "";
  if (!code) {
    return;
  }

  void navigator.clipboard.writeText(code).then(
    () => {
      btn.classList.add("copied");
      window.setTimeout(() => {
        if (!btn.isConnected) {
          return;
        }
        btn.classList.remove("copied");
      }, COPIED_FOR_MS);
    },
    () => {},
  );
}
