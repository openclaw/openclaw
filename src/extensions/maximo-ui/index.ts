import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MoltbotPluginApi, MoltbotPluginDefinition as Plugin } from "../../plugins/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const maximoUiPlugin: Plugin = {
    id: "maximo-ui",
    name: "Maximo Primo UI",
    description: "Premium Custom Web Interface for Moltbot",
    register(api: MoltbotPluginApi) {
        const logger = api.logger;
        const uiPath = path.join(__dirname, "ui");

        api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse) => {
            const url = new URL(req.url || "/", `http://${req.headers.host}`);

            // Serve at /maximo
            if (url.pathname === "/maximo" || url.pathname === "/maximo/") {
                try {
                    const content = await fs.readFile(path.join(uiPath, "index.html"), "utf-8");
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "text/html; charset=utf-8");
                    res.end(content);
                    return true;
                } catch (err) {
                    logger.error(`[MaximoUI] Failed to serve index.html: ${err}`);
                    return false;
                }
            }

            // Serve style.css
            if (url.pathname === "/maximo/style.css") {
                try {
                    const content = await fs.readFile(path.join(uiPath, "style.css"), "utf-8");
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "text/css; charset=utf-8");
                    res.end(content);
                    return true;
                } catch (err) {
                    logger.error(`[MaximoUI] Failed to serve style.css: ${err}`);
                    return false;
                }
            }

            // Serve app.js
            if (url.pathname === "/maximo/app.js") {
                try {
                    const content = await fs.readFile(path.join(uiPath, "app.js"), "utf-8");
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
                    res.end(content);
                    return true;
                } catch (err) {
                    logger.error(`[MaximoUI] Failed to serve app.js: ${err}`);
                    return false;
                }
            }

            return false;
        });

        logger.info("[MaximoUI] Plugin registered and serving at /maximo");
    }
};

export default maximoUiPlugin;
