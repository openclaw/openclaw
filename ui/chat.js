// UI-only: auto-resize textarea height and persist per-device using localStorage
(function () {
  function applySavedHeight(el) {
    try {
      const h = localStorage.getItem("openclaw.chat.inputHeight");
      if (h) {
        el.style.height = h;
      }
    } catch {
      /* ignore */
    }
  }
  function autoSize(el) {
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }
  document.addEventListener("DOMContentLoaded", function () {
    var el = document.querySelector(".field.chat-compose__field");
    if (!el) {
      return;
    }
    // Ensure element is textarea for native resize handle
    if (el.tagName.toLowerCase() !== "textarea") {
      // Try to upgrade by wrapping or replacing if possible; skip if not feasible in JS patch
      // No DOM rewrite here to avoid intrusive changes
    }
    applySavedHeight(el);
    autoSize(el);

    // Recompute size on input
    el.addEventListener("input", function () {
      autoSize(el);
    });

    // Persist height when user stops resizing (approximate via blur)
    el.addEventListener("mouseup", function () {
      try {
        localStorage.setItem("openclaw.chat.inputHeight", el.style.height);
      } catch {}
    });
    el.addEventListener("blur", function () {
      try {
        localStorage.setItem("openclaw.chat.inputHeight", el.style.height);
      } catch {}
    });
  });
})();
