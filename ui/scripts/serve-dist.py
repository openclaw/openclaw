import http.server
import os
from pathlib import Path, PurePosixPath


dist_dir = os.environ.get("DIST_DIR")
if not dist_dir:
    raise SystemExit("DIST_DIR is required")

host = os.environ.get("HOST", "localhost")
port = int(os.environ.get("PORT", "4173"))

root = Path(dist_dir).resolve()
index_path = root / "index.html"


class SpaHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(root), **kwargs)

    def _should_fallback_to_index(self) -> bool:
        # Only fallback for "app routes" like /chat, /sessions, etc.
        # If it looks like a file request (/assets/app.js, /favicon.ico), preserve 404.
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        name = PurePosixPath(path).name
        return "." not in name

    def send_head(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        full = (root / path.lstrip("/")).resolve()
        if (
            self._should_fallback_to_index()
            and not full.exists()
            and index_path.exists()
        ):
            self.path = "/index.html"
        return super().send_head()

    def end_headers(self):
        # Avoid confusing "stale HTML -> missing hashed asset" 404s during local iteration.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer((host, port), SpaHandler)
    server.serve_forever()
