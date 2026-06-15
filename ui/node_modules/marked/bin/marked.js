#!/usr/bin/env node

/**
 * Marked CLI
 * Copyright (c) 2018+, MarkedJS. (MIT License)
 * Copyright (c) 2011-2018, Christopher Jeffrey. (MIT License)
 */

import { main } from './main.js';

/**
 * Expose / Entry Point
 */

process.title = 'marked';
main(process);
