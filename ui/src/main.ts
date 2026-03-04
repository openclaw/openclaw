import "./styles.css";
import "./ui/app.ts";

// Register service worker for PWA support (app shell caching)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Service worker registration failed — app works fine without it
  });
}
