// Enhanced page script for interactive element detection
// Based on AutoGen's approach with multiple heuristics for better coverage
var OpenClawEnhancedDetection =
  OpenClawEnhancedDetection ||
  (function () {
    let nextLabel = 10;

    let roleMapping = {
      a: "link",
      area: "link",
      button: "button",
      "input, type=button": "button",
      "input, type=checkbox": "checkbox",
      "input, type=email": "textbox",
      "input, type=number": "spinbutton",
      "input, type=radio": "radio",
      "input, type=range": "slider",
      "input, type=reset": "button",
      "input, type=search": "searchbox",
      "input, type=submit": "button",
      "input, type=tel": "textbox",
      "input, type=text": "textbox",
      "input, type=url": "textbox",
      search: "search",
      select: "combobox",
      option: "option",
      textarea: "textbox",
    };

    let getCursor = function (elm) {
      return window.getComputedStyle(elm)["cursor"];
    };

    let getInteractiveElements = function (root) {
      root = root || document;
      let results = [];
      let roles = [
        "scrollbar",
        "searchbox",
        "slider",
        "spinbutton",
        "switch",
        "tab",
        "treeitem",
        "button",
        "checkbox",
        "gridcell",
        "link",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "option",
        "progressbar",
        "radio",
        "textbox",
        "combobox",
        "menu",
        "tree",
        "treegrid",
        "grid",
        "listbox",
        "radiogroup",
        "widget",
      ];
      let inertCursors = [
        "auto",
        "default",
        "none",
        "text",
        "vertical-text",
        "not-allowed",
        "no-drop",
      ];

      // Get the main interactive elements
      let nodeList = root.querySelectorAll(
        "input, select, textarea, button, [href], [onclick], [contenteditable], [tabindex]:not([tabindex='-1'])",
      );
      for (let i = 0; i < nodeList.length; i++) {
        results.push(nodeList[i]);
      }

      // Anything not already included that has a suitable role
      nodeList = root.querySelectorAll("[role]");
      for (let i = 0; i < nodeList.length; i++) {
        if (results.indexOf(nodeList[i]) == -1) {
          let role = nodeList[i].getAttribute("role");
          if (roles.indexOf(role) > -1) {
            results.push(nodeList[i]);
          }
        }
      }

      // Any element that changes the cursor to something implying interactivity
      nodeList = root.querySelectorAll("*");
      for (let i = 0; i < nodeList.length; i++) {
        let node = nodeList[i];

        // Cursor is default, or does not suggest interactivity
        let cursor = getCursor(node);
        if (inertCursors.indexOf(cursor) >= 0) {
          continue;
        }

        // Move up to the first instance of this cursor change
        let parent = node.parentNode;
        while (parent && getCursor(parent) == cursor) {
          node = parent;
          parent = node.parentNode;
        }

        // Add the node if it is new
        if (results.indexOf(node) == -1) {
          results.push(node);
        }
      }

      return results;
    };

    let labelElements = function (elements) {
      for (let i = 0; i < elements.length; i++) {
        if (!elements[i].hasAttribute("__openclaw_elementId")) {
          elements[i].setAttribute("__openclaw_elementId", "" + nextLabel++);
        }
      }
    };

    let isTopmost = function (element, x, y) {
      let hit = document.elementFromPoint(x, y);

      // Hack to handle elements outside the viewport
      if (hit === null) {
        return true;
      }

      while (hit) {
        if (hit == element) {
          return true;
        }
        hit = hit.parentNode;
      }
      return false;
    };

    let getFocusedElementId = function () {
      let elm = document.activeElement;
      while (elm) {
        if (elm.hasAttribute && elm.hasAttribute("__openclaw_elementId")) {
          return elm.getAttribute("__openclaw_elementId");
        }
        elm = elm.parentNode;
      }
      return null;
    };

    let trimmedInnerText = function (element) {
      if (!element) {
        return "";
      }
      let text = element.innerText;
      if (!text) {
        return "";
      }
      return text.trim();
    };

    let getApproximateAriaName = function (element) {
      // Check for aria labels
      if (element.hasAttribute("aria-labelledby")) {
        let buffer = "";
        let ids = element.getAttribute("aria-labelledby").split(" ");
        for (let i = 0; i < ids.length; i++) {
          let label = document.getElementById(ids[i]);
          if (label) {
            buffer = buffer + " " + trimmedInnerText(label);
          }
        }
        return buffer.trim();
      }

      if (element.hasAttribute("aria-label")) {
        return element.getAttribute("aria-label");
      }

      // Check for labels
      if (element.hasAttribute("id")) {
        let label_id = element.getAttribute("id");
        let label = "";
        let labels = document.querySelectorAll("label[for='" + label_id + "']");
        for (let j = 0; j < labels.length; j++) {
          label += labels[j].innerText + " ";
        }
        label = label.trim();
        if (label != "") {
          return label;
        }
      }

      if (element.parentElement && element.parentElement.tagName == "LABEL") {
        return element.parentElement.innerText;
      }

      // Check for alt text or titles
      if (element.hasAttribute("alt")) {
        return element.getAttribute("alt");
      }

      if (element.hasAttribute("title")) {
        return element.getAttribute("title");
      }

      return trimmedInnerText(element);
    };

    let getApproximateAriaRole = function (element) {
      let tag = element.tagName.toLowerCase();
      if (tag == "input" && element.hasAttribute("type")) {
        tag = tag + ", type=" + element.getAttribute("type");
      }

      if (element.hasAttribute("role")) {
        return [element.getAttribute("role"), tag];
      } else if (tag in roleMapping) {
        return [roleMapping[tag], tag];
      } else {
        return ["", tag];
      }
    };

    let getInteractiveRects = function (root) {
      root = root || document;
      labelElements(getInteractiveElements(root));
      let elements = root.querySelectorAll("[__openclaw_elementId]");
      let results = {};
      for (let i = 0; i < elements.length; i++) {
        let key = elements[i].getAttribute("__openclaw_elementId");
        let rects = elements[i].getClientRects();
        let ariaRole = getApproximateAriaRole(elements[i]);
        let ariaName = getApproximateAriaName(elements[i]);
        let vScrollable = elements[i].scrollHeight - elements[i].clientHeight >= 1;

        let record = {
          tag_name: ariaRole[1],
          role: ariaRole[0],
          aria_name: ariaName,
          v_scrollable: vScrollable,
          rects: [],
        };

        for (const rect of rects) {
          let x = rect.left + rect.width / 2;
          let y = rect.top + rect.height / 2;
          if (isTopmost(elements[i], x, y)) {
            record["rects"].push({
              x: rect.left,
              y: rect.top,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            });
          }
        }

        if (record["rects"].length > 0) {
          results[key] = record;
        }
      }
      return results;
    };

    let getVisualViewport = function () {
      let vv = window.visualViewport;
      let de = document.documentElement;
      return {
        height: vv ? vv.height : 0,
        width: vv ? vv.width : 0,
        offsetLeft: vv ? vv.offsetLeft : 0,
        offsetTop: vv ? vv.offsetTop : 0,
        pageLeft: vv ? vv.pageLeft : 0,
        pageTop: vv ? vv.pageTop : 0,
        scale: vv ? vv.scale : 0,
        clientWidth: de ? de.clientWidth : 0,
        clientHeight: de ? de.clientHeight : 0,
        scrollWidth: de ? de.scrollWidth : 0,
        scrollHeight: de ? de.scrollHeight : 0,
      };
    };

    let getVisibleText = function () {
      // Get the window's current viewport boundaries
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

      let textInView = "";
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);

      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        // Create a range to retrieve bounding rectangles of the current text node
        const range = document.createRange();
        range.selectNodeContents(textNode);

        const rects = range.getClientRects();

        // Check if any rect is inside (or partially inside) the viewport
        for (const rect of rects) {
          const isVisible =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom >= 0 &&
            rect.right >= 0 &&
            rect.top <= viewportHeight &&
            rect.left <= viewportWidth;

          if (isVisible) {
            textInView += textNode.nodeValue.replace(/\s+/g, " ");
            // Is the parent a block element?
            if (textNode.parentNode) {
              const parent = textNode.parentNode;
              const style = window.getComputedStyle(parent);
              if (["inline", "hidden", "none"].indexOf(style.display) === -1) {
                textInView += "\n";
              }
            }
            break; // No need to check other rects once found visible
          }
        }
      }

      // Remove blank lines from textInView
      textInView = textInView
        .replace(/^\s*\n/gm, "")
        .trim()
        .replace(/\n+/g, "\n");
      return textInView;
    };

    return {
      getInteractiveRects: getInteractiveRects,
      getVisualViewport: getVisualViewport,
      getFocusedElementId: getFocusedElementId,
      getVisibleText: getVisibleText,
    };
  })();
