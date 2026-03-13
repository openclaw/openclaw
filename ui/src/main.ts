import "./styles.css";
import "./ui/app.ts";

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("./sw.js");
}
