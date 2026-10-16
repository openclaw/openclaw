-- Generated v26-to-v27 publication after the local credential owner has verified and retired source rows.
UPDATE schema_meta SET schema_version = 27 WHERE meta_key = 'primary' AND schema_version = 26;
